import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { get } from '../../lib/browsers/index.js'
import { row } from './list-fixture.js'
import {
  copyProfile, seedFromGolden, promote, sweepStale, migrateGolden,
  profileBrowserPids, dirHasContent
} from '../../lib/session.js'

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-ss-'))
const write = (f, s = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s) }

function ctxFor (root, key = 'k1', browser = 'chromium') {
  const stateDir = path.join(root, 'sessions', key)
  return {
    stateRoot: root, sessionKey: key, session: `pw-${key}`, isolated: true,
    stateDir, profileDir: path.join(stateDir, 'profile'),
    goldenDir: path.join(root, 'golden', browser),
    browser, seed: true, ephemeral: false, ttlDays: 7, platform: 'linux'
  }
}

test('copyProfile drops caches and lock files', async () => {
  const src = mk(); const dst = path.join(mk(), 'out')
  write(path.join(src, 'Default', 'Cookies'))
  write(path.join(src, 'Default', 'Cache', 'big'))
  write(path.join(src, 'SingletonLock'))
  assert.equal(await copyProfile(src, dst, get('chromium')), true)
  assert.equal(fs.existsSync(path.join(dst, 'Default', 'Cookies')), true)
  assert.equal(fs.existsSync(path.join(dst, 'Default', 'Cache')), false)
  assert.equal(fs.existsSync(path.join(dst, 'SingletonLock')), false)
})

test('copyProfile expands a glob prune entry', async () => {
  const src = mk(); const dst = path.join(mk(), 'out')
  write(path.join(src, 'storage', 'default', 'https+++a', 'cache', 'junk'))
  write(path.join(src, 'storage', 'default', 'https+++a', 'ls', 'keep'))
  const adapter = { ...get('firefox'), pruneDirs: ['storage/default/*/cache'] }
  await copyProfile(src, dst, adapter)
  assert.equal(fs.existsSync(path.join(dst, 'storage', 'default', 'https+++a', 'cache')), false)
  assert.equal(fs.existsSync(path.join(dst, 'storage', 'default', 'https+++a', 'ls', 'keep')), true)
})

test('seedFromGolden copies golden into an empty session profile', async () => {
  const root = mk(); const ctx = ctxFor(root)
  write(path.join(ctx.goldenDir, 'Default', 'Cookies'))
  assert.equal(await seedFromGolden(ctx, get('chromium')), 'seeded')
  assert.equal(fs.existsSync(path.join(ctx.profileDir, 'Default', 'Cookies')), true)
})

test('seedFromGolden refuses to clobber an existing profile and honours no-seed', async () => {
  const root = mk(); const ctx = ctxFor(root)
  write(path.join(ctx.goldenDir, 'g'))
  write(path.join(ctx.profileDir, 'mine'))
  assert.equal(await seedFromGolden(ctx, get('chromium')), 'skipped')
  assert.equal(fs.existsSync(path.join(ctx.profileDir, 'mine')), true)

  const ctx2 = ctxFor(root, 'k2')
  write(path.join(ctx2.goldenDir, 'g'))
  write(path.join(ctx2.stateDir, 'no-seed'), '')
  assert.equal(await seedFromGolden(ctx2, get('chromium')), 'skipped')
})

test('seedFromGolden losing the install race leaves the winner\'s profile alone', async () => {
  // Two opens in one session both pass the empty-profile check, then race to
  // install. Removing the destination to make room for our own rename deleted
  // the winner's freshly seeded profile, possibly while its browser was
  // already launching on it. The loser must stand down, not overwrite.
  const root = mk(); const ctx = ctxFor(root)
  write(path.join(ctx.goldenDir, 'Default', 'Cookies'), 'golden')
  const deps = {
    // The winner lands its profile while our copy is still staging.
    cp: async (src, dst, opts) => {
      await fs.promises.cp(src, dst, opts)
      write(path.join(ctx.profileDir, 'Default', 'Cookies'), 'winner')
    }
  }
  assert.equal(await seedFromGolden(ctx, get('chromium'), deps), 'seeded')
  assert.equal(fs.readFileSync(path.join(ctx.profileDir, 'Default', 'Cookies'), 'utf8'), 'winner')
  assert.deepEqual(
    fs.readdirSync(ctx.stateDir).filter(f => f.startsWith('profile.seeding.')), [],
    'the loser must clean up its own staging directory'
  )
})

test('seedFromGolden still installs into a profile directory that exists but is empty', async () => {
  // Left behind by an earlier failed launch. rename onto it fails outright on
  // Windows, so the empty directory is removed first (rmdir, which refuses on
  // a non-empty one).
  const root = mk(); const ctx = ctxFor(root)
  write(path.join(ctx.goldenDir, 'Default', 'Cookies'), 'golden')
  fs.mkdirSync(ctx.profileDir, { recursive: true })
  assert.equal(await seedFromGolden(ctx, get('chromium')), 'seeded')
  assert.equal(fs.readFileSync(path.join(ctx.profileDir, 'Default', 'Cookies'), 'utf8'), 'golden')
})

test('promote installs into a golden directory that exists but is empty', async () => {
  const root = mk(); const ctx = ctxFor(root)
  write(path.join(ctx.profileDir, 'Default', 'Cookies'), 'new')
  fs.mkdirSync(ctx.goldenDir, { recursive: true })
  const deps = {
    listProcesses: async () => [],
    // Windows semantics: rename fails onto any existing directory, empty or not.
    rename: async (src, dst) => {
      if (fs.existsSync(dst)) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e }
      return fs.promises.rename(src, dst)
    }
  }
  const res = await promote(ctx, get('chromium'), deps)
  assert.equal(res.ok, true, res.error)
  assert.equal(fs.readFileSync(path.join(ctx.goldenDir, 'Default', 'Cookies'), 'utf8'), 'new')
})

test('migrateGolden lifts a flat golden into golden/chromium once', async () => {
  const root = mk()
  write(path.join(root, 'golden', 'Default', 'Cookies'))
  const ctx = ctxFor(root)
  assert.equal(await migrateGolden(ctx), true)
  assert.equal(fs.existsSync(path.join(root, 'golden', 'chromium', 'Default', 'Cookies')), true)
  assert.equal(await migrateGolden(ctx), false)
})

test('promote refuses while a browser holds the profile', async () => {
  const root = mk(); const ctx = ctxFor(root)
  write(path.join(ctx.profileDir, 'Default', 'Cookies'))
  const deps = { listProcesses: async () => [{ pid: 9, cmdline: `chrome --user-data-dir=${ctx.profileDir}` }] }
  const res = await promote(ctx, get('chromium'), deps)
  assert.equal(res.ok, false)
  assert.match(res.error, /still running/)
})

test('promote swaps golden into place on the ordinary successful path', async () => {
  const root = mk(); const ctx = ctxFor(root)
  write(path.join(ctx.profileDir, 'Default', 'Cookies'), 'new')
  write(path.join(ctx.goldenDir, 'Default', 'Cookies'), 'old')
  const deps = { listProcesses: async () => [] }
  const res = await promote(ctx, get('chromium'), deps)
  assert.equal(res.ok, true)
  assert.equal(fs.readFileSync(path.join(ctx.goldenDir, 'Default', 'Cookies'), 'utf8'), 'new')
  assert.equal(fs.existsSync(`${ctx.goldenDir}.old`), false)
})

test('promote returns an error and leaves golden untouched when the install rename fails', async () => {
  const root = mk(); const ctx = ctxFor(root)
  write(path.join(ctx.profileDir, 'Default', 'Cookies'), 'new')
  write(path.join(ctx.goldenDir, 'Default', 'Cookies'), 'original')
  const stagingPrefix = `${ctx.goldenDir}.promoting.`
  const deps = {
    listProcesses: async () => [],
    rename: async (src, dst) => {
      if (src.startsWith(stagingPrefix) && dst === ctx.goldenDir) throw new Error('boom')
      return fs.promises.rename(src, dst)
    }
  }
  const res = await promote(ctx, get('chromium'), deps)
  assert.equal(res.ok, false)
  assert.equal(fs.readFileSync(path.join(ctx.goldenDir, 'Default', 'Cookies'), 'utf8'), 'original')
})

test('promote reports the surviving backup path when both the install and the restore fail', async () => {
  const root = mk(); const ctx = ctxFor(root)
  write(path.join(ctx.profileDir, 'Default', 'Cookies'), 'new')
  write(path.join(ctx.goldenDir, 'Default', 'Cookies'), 'original')
  const old = `${ctx.goldenDir}.old`
  const deps = {
    listProcesses: async () => [],
    rename: async (src, dst) => {
      if (dst === ctx.goldenDir) throw new Error('boom')
      return fs.promises.rename(src, dst)
    }
  }
  const res = await promote(ctx, get('chromium'), deps)
  assert.equal(res.ok, false)
  assert.ok(res.error.includes(old), `expected error to name ${old}, got: ${res.error}`)
  assert.equal(fs.readFileSync(path.join(old, 'Default', 'Cookies'), 'utf8'), 'original')
})

test('promote recovers a stranded backup instead of deleting it when golden is missing', async () => {
  const root = mk(); const ctx = ctxFor(root)
  write(path.join(ctx.profileDir, 'Default', 'Cookies'), 'new')
  write(path.join(`${ctx.goldenDir}.old`, 'Default', 'Cookies'), 'stranded')
  const calls = []
  const deps = {
    listProcesses: async () => [],
    rename: async (src, dst) => { calls.push([src, dst]); return fs.promises.rename(src, dst) }
  }
  const res = await promote(ctx, get('chromium'), deps)
  assert.equal(res.ok, true)
  assert.equal(fs.readFileSync(path.join(ctx.goldenDir, 'Default', 'Cookies'), 'utf8'), 'new')
  assert.equal(fs.existsSync(`${ctx.goldenDir}.old`), false)
  assert.ok(
    calls.some(([src, dst]) => src === `${ctx.goldenDir}.old` && dst === ctx.goldenDir),
    'expected the stranded backup to be recovered via rename, not deleted'
  )
})

test('promote fails without deleting the backup when the recovery rename itself fails', async () => {
  const root = mk(); const ctx = ctxFor(root)
  write(path.join(ctx.profileDir, 'Default', 'Cookies'), 'new')
  const old = `${ctx.goldenDir}.old`
  write(path.join(old, 'Default', 'Cookies'), 'stranded')
  const deps = {
    listProcesses: async () => [],
    // Only the recovery rename (old -> golden) fails; the install rename
    // (staging -> golden) is left free to succeed normally.
    rename: async (src, dst) => {
      if (src === old && dst === ctx.goldenDir) throw new Error('EACCES')
      return fs.promises.rename(src, dst)
    }
  }
  const res = await promote(ctx, get('chromium'), deps)
  assert.equal(res.ok, false)
  assert.ok(res.error.includes(old), `expected error to name ${old}, got: ${res.error}`)
  assert.equal(fs.readFileSync(path.join(old, 'Default', 'Cookies'), 'utf8'), 'stranded')
})

test('profileBrowserPids matches the exact dir only', async () => {
  const dir = mk()
  const listProcesses = async () => [
    { pid: 1, cmdline: `chrome --user-data-dir=${dir}` },
    { pid: 2, cmdline: `chrome --user-data-dir=${dir}-2` },
    { pid: 3, cmdline: 'chrome --user-data-dir=/elsewhere' }
  ]
  assert.deepEqual(await profileBrowserPids(get('chromium'), dir, { listProcesses, platform: 'linux' }), [1])
})

test('sweepStale keeps live, current, listed, and fresh sessions', async () => {
  const root = mk(); const ctx = ctxFor(root, 'cur')
  const old = Date.now() / 1000 - 30 * 86400
  for (const k of ['cur', 'live', 'listed', 'fresh', 'stale']) {
    write(path.join(root, 'sessions', k, 'profile', 'x'))
    fs.writeFileSync(path.join(root, 'sessions', k, 'last-used'), String(k === 'fresh' ? Date.now() / 1000 : old))
  }
  const deps = {
    listProcesses: async () => [{ pid: 5, cmdline: `chrome --user-data-dir=${path.join(root, 'sessions', 'live', 'profile')}` }]
  }
  // sweepStale reads the parsed `list --json` rows, the same shape
  // engine.sessionState reads, not the rendered listing — so the two can
  // never disagree about who is open.
  const rows = [row('pw-listed')]
  const removed = await sweepStale(ctx, { rows, deps })
  assert.equal(removed, 1)
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'stale')), false)
  for (const k of ['cur', 'live', 'listed', 'fresh']) {
    assert.equal(fs.existsSync(path.join(root, 'sessions', k)), true, k)
  }
})

test('sweepStale skips the row-match-protected removal entirely when the listing is unreadable', async () => {
  // rows === null means "could not tell who is open" — the same could-not-tell
  // signal engine.listSessions/parseBrowsers return for output that failed or
  // could not be read. Proceeding without the listing's protection would risk
  // deleting a session that is actually open; skipping is the conservative
  // choice.
  const root = mk(); const ctx = ctxFor(root, 'cur')
  const old = Date.now() / 1000 - 30 * 86400
  for (const k of ['cur', 'stale']) {
    write(path.join(root, 'sessions', k, 'profile', 'x'))
    fs.writeFileSync(path.join(root, 'sessions', k, 'last-used'), String(old))
  }
  const removed = await sweepStale(ctx, { rows: null })
  assert.equal(removed, 0)
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'stale')), true)
})

test('dirHasContent', () => {
  const d = mk()
  assert.equal(dirHasContent(d), false)
  write(path.join(d, 'a'))
  assert.equal(dirHasContent(d), true)
  assert.equal(dirHasContent(path.join(d, 'nope')), false)
})
