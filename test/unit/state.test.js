import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { get } from '../../lib/browsers/index.js'
import {
  seedFromGolden, promote, snapshotPath, statePendingPath,
  captureStorageState, applyPendingState, mkdirPrivate
} from '../../lib/session.js'

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-st-'))
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

// --- permissions -----------------------------------------------------------
//
// The snapshot is session cookies in plaintext, unlike Chromium's own
// keychain-encrypted store. Written with default modes under a default
// directory it was readable by any other local account on a shared machine.

const posix = { skip: process.platform === 'win32' ? 'POSIX modes only' : false }
const mode = p => fs.statSync(p).mode & 0o777

test('captureStorageState leaves the profile directory and the snapshot owner-only', posix, async () => {
  const root = mk(); const ctx = ctxFor(root, 'k1', 'chromium')
  const local = { ...ctx, platform: process.platform }
  // playwright-cli writes the snapshot itself, with its own mode.
  const run = async () => {
    fs.writeFileSync(snapshotPath(local.profileDir), '{"cookies":[]}', { mode: 0o644 })
    return { code: 0, stdout: '', stderr: '' }
  }
  assert.equal(await captureStorageState(local, run), true)
  assert.equal(mode(local.profileDir), 0o700)
  assert.equal(mode(snapshotPath(local.profileDir)), 0o600)
})

test('a seeded session profile and its carried snapshot are owner-only', posix, async () => {
  const root = mk(); const ctx = { ...ctxFor(root), platform: process.platform }
  write(path.join(ctx.goldenDir, 'Default', 'Cookies'))
  fs.writeFileSync(snapshotPath(ctx.goldenDir), '{}', { mode: 0o644 })
  fs.chmodSync(snapshotPath(ctx.goldenDir), 0o644)
  assert.equal(await seedFromGolden(ctx, get('chromium')), 'seeded')
  assert.equal(mode(ctx.stateDir), 0o700)
  assert.equal(mode(ctx.profileDir), 0o700)
  assert.equal(mode(snapshotPath(ctx.profileDir)), 0o600)
})

test('a promoted golden and its snapshot are owner-only', posix, async () => {
  const root = mk(); const ctx = { ...ctxFor(root), platform: process.platform }
  write(path.join(ctx.profileDir, 'Default', 'Cookies'), 'new')
  fs.writeFileSync(snapshotPath(ctx.profileDir), '{}')
  fs.chmodSync(snapshotPath(ctx.profileDir), 0o644)
  const res = await promote(ctx, get('chromium'), { listProcesses: async () => [] })
  assert.equal(res.ok, true, res.error)
  assert.equal(mode(ctx.goldenDir), 0o700)
  assert.equal(mode(snapshotPath(ctx.goldenDir)), 0o600)
})

test('mkdirPrivate is a no-op, not an error, on Windows', () => {
  const dir = path.join(mk(), 'a', 'b')
  mkdirPrivate(dir, 'win32')
  assert.equal(fs.existsSync(dir), true)
})

// --- capture ---------------------------------------------------------------

test('captureStorageState calls state-save with an absolute path inside the profile', async () => {
  const root = mk(); const ctx = ctxFor(root)
  const calls = []
  const run = async (c, args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' } }
  assert.equal(await captureStorageState(ctx, run), true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['state-save', snapshotPath(ctx.profileDir)])
  assert.equal(fs.existsSync(ctx.profileDir), true, 'expected the profile dir to exist so state-save has somewhere to write')
})

test('captureStorageState is a no-op for an ephemeral session', async () => {
  const root = mk(); const ctx = { ...ctxFor(root), ephemeral: true }
  let called = false
  const run = async () => { called = true; return { code: 0 } }
  assert.equal(await captureStorageState(ctx, run), false)
  assert.equal(called, false)
})

test('captureStorageState swallows a failing run without throwing', async () => {
  const root = mk(); const ctx = ctxFor(root)
  const run = async () => { throw new Error('boom') }
  assert.equal(await captureStorageState(ctx, run), false)
  const run2 = async () => ({ code: 1, stdout: '', stderr: 'nope' })
  assert.equal(await captureStorageState(ctx, run2), false)
})

// --- apply -------------------------------------------------------------

test('applyPendingState applies once, then clears the marker so a second call is a no-op', async () => {
  const root = mk(); const ctx = ctxFor(root)
  write(snapshotPath(ctx.profileDir), '{}')
  fs.mkdirSync(ctx.stateDir, { recursive: true })
  fs.writeFileSync(statePendingPath(ctx), '')
  const calls = []
  const run = async (c, args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' } }

  assert.equal(await applyPendingState(ctx, run), 'applied')
  assert.equal(fs.existsSync(statePendingPath(ctx)), false)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['state-load', snapshotPath(ctx.profileDir)])

  assert.equal(await applyPendingState(ctx, run), 'none')
  assert.equal(calls.length, 1, 'must not re-apply once the marker is gone')
})

test('applyPendingState clears the marker even when state-load fails, and never throws', async () => {
  const root = mk(); const ctx = ctxFor(root)
  write(snapshotPath(ctx.profileDir), '{}')
  fs.mkdirSync(ctx.stateDir, { recursive: true })
  fs.writeFileSync(statePendingPath(ctx), '')
  const run = async () => { throw new Error('boom') }
  assert.equal(await applyPendingState(ctx, run), 'failed')
  assert.equal(fs.existsSync(statePendingPath(ctx)), false)
})

test('applyPendingState with no marker present is a silent no-op', async () => {
  const root = mk(); const ctx = ctxFor(root)
  let called = false
  const run = async () => { called = true; return { code: 0 } }
  assert.equal(await applyPendingState(ctx, run), 'none')
  assert.equal(called, false)
})

// --- seed carries the snapshot + records the pending marker -----------------

test('seedFromGolden carries a golden snapshot in and records the pending marker', async () => {
  const root = mk(); const ctx = ctxFor(root)
  write(path.join(ctx.goldenDir, 'Default', 'Cookies'))
  write(snapshotPath(ctx.goldenDir), '{"cookies":[{"name":"pwx"}]}')
  assert.equal(await seedFromGolden(ctx, get('chromium')), 'seeded')
  assert.equal(fs.existsSync(snapshotPath(ctx.profileDir)), true)
  assert.equal(fs.readFileSync(snapshotPath(ctx.profileDir), 'utf8'), '{"cookies":[{"name":"pwx"}]}')
  assert.equal(fs.existsSync(statePendingPath(ctx)), true)
})

test('seedFromGolden without a golden snapshot records no pending marker', async () => {
  const root = mk(); const ctx = ctxFor(root)
  write(path.join(ctx.goldenDir, 'Default', 'Cookies'))
  assert.equal(await seedFromGolden(ctx, get('chromium')), 'seeded')
  assert.equal(fs.existsSync(statePendingPath(ctx)), false)
})

test('a session with the no-seed marker, or with seeding disabled, receives no snapshot', async () => {
  const root = mk()

  const ctx1 = ctxFor(root, 'k1')
  write(path.join(ctx1.goldenDir, 'Default', 'Cookies'))
  write(snapshotPath(ctx1.goldenDir), '{}')
  write(path.join(ctx1.stateDir, 'no-seed'), '')
  assert.equal(await seedFromGolden(ctx1, get('chromium')), 'skipped')
  assert.equal(fs.existsSync(snapshotPath(ctx1.profileDir)), false)
  assert.equal(fs.existsSync(statePendingPath(ctx1)), false)

  const ctx2 = { ...ctxFor(root, 'k2'), seed: false }
  write(path.join(ctx2.goldenDir, 'Default', 'Cookies'))
  write(snapshotPath(ctx2.goldenDir), '{}')
  assert.equal(await seedFromGolden(ctx2, get('chromium')), 'skipped')
  assert.equal(fs.existsSync(snapshotPath(ctx2.profileDir)), false)
  assert.equal(fs.existsSync(statePendingPath(ctx2)), false)

  const ctx3 = { ...ctxFor(root, 'k3'), ephemeral: true }
  write(path.join(ctx3.goldenDir, 'Default', 'Cookies'))
  write(snapshotPath(ctx3.goldenDir), '{}')
  assert.equal(await seedFromGolden(ctx3, get('chromium')), 'skipped')
  assert.equal(fs.existsSync(ctx3.profileDir), false)
})

// --- promote carries the snapshot atomically with the profile --------------

test('promote carries the snapshot into golden alongside the profile', async () => {
  const root = mk(); const ctx = ctxFor(root)
  write(path.join(ctx.profileDir, 'Default', 'Cookies'), 'new')
  write(snapshotPath(ctx.profileDir), '{"cookies":[{"name":"pwx"}]}')
  const deps = { listProcesses: async () => [] }
  const res = await promote(ctx, get('chromium'), deps)
  assert.equal(res.ok, true)
  assert.equal(fs.existsSync(snapshotPath(ctx.goldenDir)), true)
  assert.equal(fs.readFileSync(snapshotPath(ctx.goldenDir), 'utf8'), '{"cookies":[{"name":"pwx"}]}')
})

test('a promote whose profile copy fails leaves no snapshot behind in golden', async () => {
  const root = mk(); const ctx = ctxFor(root)
  write(path.join(ctx.profileDir, 'Default', 'Cookies'), 'new')
  write(snapshotPath(ctx.profileDir), '{"cookies":[{"name":"pwx"}]}')
  write(path.join(ctx.goldenDir, 'Default', 'Cookies'), 'old')
  const deps = { listProcesses: async () => [], cp: async () => { throw new Error('boom') } }
  const res = await promote(ctx, get('chromium'), deps)
  assert.equal(res.ok, false)
  assert.equal(fs.existsSync(snapshotPath(ctx.goldenDir)), false)
  assert.equal(fs.readFileSync(path.join(ctx.goldenDir, 'Default', 'Cookies'), 'utf8'), 'old',
    'golden must be untouched, not partially overwritten with just the profile or just the snapshot')
})
