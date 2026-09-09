import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { snapshotPath, statePendingPath } from '../../lib/session.js'
import { row, listFile } from './list-fixture.js'

const CLI = path.resolve('bin/pwx.js')
const STUB = path.resolve('test/stub/playwright-cli.js')

function runIn (root, args, env = {}) {
  const log = path.join(root, 'log')
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        PW_BIN: STUB,
        PW_STUB_LOG: log,
        PW_STATE_ROOT: root,
        PW_SCRATCH_DIR: path.join(root, 'scratch'),
        CLAUDE_CODE_SESSION_ID: 'sess1',
        ...env
      }
    }, (err, stdout, stderr) => {
      const calls = fs.existsSync(log)
        ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
        : []
      resolve({ code: err?.code ?? 0, stdout, stderr, calls })
    })
  })
}
const mkroot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-v-'))
const write = (f, s = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s) }

test('hide writes the mode file and future opens are headless', async () => {
  const root = mkroot()
  await runIn(root, ['hide'], { PW_STUB_LIST: listFile(root, []) })
  assert.equal(fs.readFileSync(path.join(root, 'sessions', 'sess1', 'mode'), 'utf8').trim(), 'headless')
  const r = await runIn(root, ['open', 'https://e.test'], { PW_STUB_LIST: listFile(root, []) })
  const openCall = r.calls.find(c => c.argv.includes('open'))
  assert.equal(openCall.env.PLAYWRIGHT_MCP_HEADLESS, 'true')
})

test('show on a live headless session relaunches headed and restores the URL', async () => {
  const root = mkroot()
  const lf = listFile(root, [row('pw-sess1', { headed: false })])
  const r = await runIn(root, ['show'], { PW_STUB_LIST: lf })
  assert.ok(r.calls.some(c => c.argv.includes('eval')), 'should capture the current URL')
  assert.ok(r.calls.some(c => c.argv.includes('close')))
  const openCall = r.calls.find(c => c.argv.includes('open'))
  assert.equal(openCall.env.PLAYWRIGHT_MCP_HEADLESS, 'false')
})

test('status prints session, browser, profile, and mode', async () => {
  const root = mkroot()
  const r = await runIn(root, ['status'], { PW_STUB_LIST: listFile(root, []) })
  assert.match(r.stdout, /this session: 'pw-sess1'/)
  assert.match(r.stdout, /browser: chromium/)
  assert.match(r.stdout, /profile: /)
  assert.match(r.stdout, /default mode: headed/)
})

test('gc refuses to reap when the state is unknown', async () => {
  const root = mkroot()
  const r = await runIn(root, ['gc'], { PW_STUB_EXIT: '5' })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /Refusing to reap/)
})

test('promote copies the session profile to golden/<browser>', async () => {
  const root = mkroot()
  write(path.join(root, 'sessions', 'sess1', 'profile', 'Default', 'Cookies'), 'c')
  const r = await runIn(root, ['promote'], { PW_STUB_LIST: listFile(root, []) })
  assert.equal(r.code, 0)
  assert.equal(fs.existsSync(path.join(root, 'golden', 'chromium', 'Default', 'Cookies')), true)
  assert.match(r.stdout, /promoted/)
})

test('promote refuses when --browser does not match the session\'s recorded browser', async () => {
  // Without this guard, copyProfile() would pick firefox's prune/lock rules
  // for a chromium-format profile and corrupt golden/firefox: the profile
  // every future firefox session seeds from. See the comment above the
  // recorded-browser guard in bin/pwx.js.
  const root = mkroot()
  write(path.join(root, 'sessions', 'sess1', 'browser'), 'chromium')
  write(path.join(root, 'sessions', 'sess1', 'profile', 'Default', 'Cookies'), 'c')
  const r = await runIn(root, ['promote', '--browser', 'firefox'], { PW_STUB_LIST: listFile(root, []) })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /already running chromium/)
  assert.equal(fs.existsSync(path.join(root, 'golden', 'firefox')), false)
})

test('forget deletes the profile and blocks re-seeding', async () => {
  const root = mkroot()
  write(path.join(root, 'sessions', 'sess1', 'profile', 'x'))
  write(path.join(root, 'sessions', 'sess1', 'browser'), 'chromium')
  write(path.join(root, 'golden', 'chromium', 'g'))
  const r = await runIn(root, ['forget'], { PW_STUB_LIST: listFile(root, []) })
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'sess1', 'profile')), false)
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'sess1', 'no-seed')), true)
  // Controller ruling: forget must also clear the recorded-browser marker, or
  // the "run pwx end then pwx forget to switch browsers" advice in the open/
  // fresh guard is a lie — nothing else removes this file.
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'sess1', 'browser')), false)
  assert.match(r.stdout, /golden profile still holds logins/)
})

test('forget clears a pending storage-state marker too, so a stale marker cannot outlive it', async () => {
  const root = mkroot()
  write(path.join(root, 'sessions', 'sess1', 'profile', 'x'))
  const ctx = { stateDir: path.join(root, 'sessions', 'sess1') }
  write(statePendingPath(ctx), '')
  await runIn(root, ['forget'], { PW_STUB_LIST: listFile(root, []) })
  assert.equal(fs.existsSync(statePendingPath(ctx)), false)
})

test('forget --golden clears the seed too', async () => {
  const root = mkroot()
  write(path.join(root, 'sessions', 'sess1', 'profile', 'x'))
  write(path.join(root, 'golden', 'chromium', 'g'))
  await runIn(root, ['forget', '--golden'], { PW_STUB_LIST: listFile(root, []) })
  assert.equal(fs.existsSync(path.join(root, 'golden', 'chromium')), false)
})

test('nuke is scoped by default and machine-wide with --all', async () => {
  const root = mkroot()
  const lf = listFile(root, [])
  const scoped = await runIn(root, ['nuke'], { PW_STUB_LIST: lf })
  assert.ok(!scoped.calls.some(c => c.argv.includes('kill-all')))
  assert.match(scoped.stdout, /other sessions and .* left alone/)
  const all = await runIn(root, ['nuke', '--all'], { PW_STUB_LIST: lf })
  assert.ok(all.calls.some(c => c.argv.includes('kill-all')))
})

// --- storage-state capture: one shared call site, before every session-scoped close ---

function captureBeforeClose (calls) {
  const saveIdx = calls.findIndex(c => c.argv.includes('state-save'))
  const closeIdx = calls.findIndex(c => c.argv.includes('close'))
  return { saveIdx, closeIdx }
}

test('end captures storage state before closing', async () => {
  const root = mkroot()
  const r = await runIn(root, ['end'], { PW_STUB_LIST: listFile(root, []) })
  const { saveIdx, closeIdx } = captureBeforeClose(r.calls)
  assert.ok(saveIdx >= 0 && closeIdx >= 0, `expected both a state-save and a close call; got ${JSON.stringify(r.calls.map(c => c.argv))}`)
  assert.ok(saveIdx < closeIdx, 'state-save must run before close')
})

test('fresh captures storage state before closing the old browser', async () => {
  const root = mkroot()
  const r = await runIn(root, ['fresh', 'https://e.test'], { PW_STUB_LIST: listFile(root, []) })
  const { saveIdx, closeIdx } = captureBeforeClose(r.calls)
  assert.ok(saveIdx >= 0 && closeIdx >= 0)
  assert.ok(saveIdx < closeIdx)
})

test('nuke (scoped) captures storage state before closing', async () => {
  const root = mkroot()
  const r = await runIn(root, ['nuke'], { PW_STUB_LIST: listFile(root, []) })
  const { saveIdx, closeIdx } = captureBeforeClose(r.calls)
  assert.ok(saveIdx >= 0 && closeIdx >= 0)
  assert.ok(saveIdx < closeIdx)
})

test('nuke --all does not attempt a per-session capture', async () => {
  const root = mkroot()
  const r = await runIn(root, ['nuke', '--all'], { PW_STUB_LIST: listFile(root, []) })
  assert.ok(!r.calls.some(c => c.argv.includes('state-save')))
})

test('hide captures storage state before relaunching headless', async () => {
  const root = mkroot()
  const lf = listFile(root, [row('pw-sess1', { headed: true })])
  const r = await runIn(root, ['hide'], { PW_STUB_LIST: lf })
  const { saveIdx, closeIdx } = captureBeforeClose(r.calls)
  assert.ok(saveIdx >= 0 && closeIdx >= 0, `expected a relaunch with capture; got ${JSON.stringify(r.calls.map(c => c.argv))}`)
  assert.ok(saveIdx < closeIdx)
})

test('show captures storage state before relaunching headed', async () => {
  const root = mkroot()
  const lf = listFile(root, [row('pw-sess1', { headed: false })])
  const r = await runIn(root, ['show'], { PW_STUB_LIST: lf })
  const { saveIdx, closeIdx } = captureBeforeClose(r.calls)
  assert.ok(saveIdx >= 0 && closeIdx >= 0)
  assert.ok(saveIdx < closeIdx)
})

test('forget does not capture — it exists to throw the login away, not snapshot it on the way out', async () => {
  const root = mkroot()
  write(path.join(root, 'sessions', 'sess1', 'profile', 'x'))
  const r = await runIn(root, ['forget'], { PW_STUB_LIST: listFile(root, []) })
  assert.ok(!r.calls.some(c => c.argv.includes('state-save')))
})

test('end still succeeds and prints its normal message when capture fails', async () => {
  const root = mkroot()
  const r = await runIn(root, ['end'], {
    PW_STUB_LIST: listFile(root, []),
    PW_STUB_FAIL_VERBS: 'state-save'
  })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /closed/)
})

// --- apply: first open of a freshly seeded session, once ---

test('open on a freshly seeded session applies the pending snapshot before navigating, then does not reapply it', async () => {
  const root = mkroot()
  write(path.join(root, 'golden', 'chromium', 'Default', 'Cookies'), 'c')
  write(snapshotPath(path.join(root, 'golden', 'chromium')), '{}')
  const lf = listFile(root, [])

  const r = await runIn(root, ['open', 'https://example.test'], { PW_STUB_LIST: lf })
  const argvs = r.calls.map(c => c.argv)
  const openIdx = argvs.findIndex(a => a.includes('open'))
  const loadIdx = argvs.findIndex(a => a.includes('state-load'))
  const gotoIdx = argvs.findIndex(a => a.includes('goto'))
  assert.ok(openIdx >= 0 && loadIdx >= 0 && gotoIdx >= 0, `expected open, state-load, and goto calls; got ${JSON.stringify(argvs)}`)
  assert.ok(openIdx < loadIdx && loadIdx < gotoIdx, 'expected open, then state-load, then goto, in that order')
  const ctx = { stateDir: path.join(root, 'sessions', 'sess1') }
  assert.equal(fs.existsSync(statePendingPath(ctx)), false, 'the pending marker must be cleared after the first apply')

  // Second open of the same, now-seeded session: profile already has
  // content, so it is not reseeded, and the marker is already gone — no
  // state-load, and back to the ordinary single open+navigate call.
  // runIn always logs to the same `root/log` file, so the stub keeps
  // appending across calls in this test — only the calls made after the
  // first run's count belong to this second run.
  const lf2 = listFile(root, [])
  const r2 = await runIn(root, ['open', 'https://example.test'], { PW_STUB_LIST: lf2 })
  const secondRunCalls = r2.calls.slice(r.calls.length)
  assert.ok(!secondRunCalls.some(c => c.argv.includes('state-load')), 'must not re-apply on a later open')
})

test('open on an ordinary (non-pending) session keeps the single combined open+navigate call', async () => {
  const root = mkroot()
  const lf = listFile(root, [])
  const r = await runIn(root, ['open', 'https://example.test'], { PW_STUB_LIST: lf })
  assert.ok(!r.calls.some(c => c.argv.includes('state-load')))
  assert.ok(!r.calls.some(c => c.argv.includes('goto')))
  const openCall = r.calls.find(c => c.argv.includes('open'))
  assert.ok(openCall.argv.includes('https://example.test'), 'the url should travel with the same open call as before this feature')
})
