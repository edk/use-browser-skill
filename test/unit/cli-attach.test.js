import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { attachedMarkerPath } from '../../lib/session.js'
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
        // Pinned so the token-absent/-present tests are not at the mercy of
        // whatever happens to be exported in the shell running the suite.
        PLAYWRIGHT_MCP_EXTENSION_TOKEN: '',
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

const mkroot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-attach-'))
const write = (f, s = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s) }
const markerFor = root => attachedMarkerPath({ stateDir: path.join(root, 'sessions', 'sess1') })
const markAttached = (root, channel = 'chrome') => write(markerFor(root), `${channel}\n`)

// --- entering attach mode ---

test('attach invokes the engine with the extension flag, defaulting to chrome', async () => {
  const root = mkroot()
  const r = await runIn(root, ['attach'], { PW_STUB_LIST: listFile(root, []) })
  assert.equal(r.code, 0, r.stderr)
  const attachCall = r.calls.find(c => c.argv.includes('attach'))
  assert.ok(attachCall, `expected an attach call; got ${JSON.stringify(r.calls.map(c => c.argv))}`)
  assert.ok(attachCall.argv.includes('--extension=chrome'))
  assert.match(r.stdout, /attached to your real chrome browser/)
})

test('attach accepts an explicit channel argument', async () => {
  const root = mkroot()
  const r = await runIn(root, ['attach', 'msedge'], { PW_STUB_LIST: listFile(root, []) })
  assert.equal(r.code, 0, r.stderr)
  const attachCall = r.calls.find(c => c.argv.includes('attach'))
  assert.ok(attachCall.argv.includes('--extension=msedge'))
  assert.equal(fs.readFileSync(markerFor(root), 'utf8').trim(), 'msedge')
})

test('attach records the attached state to disk so a later, separate process reads it back', async () => {
  const root = mkroot()
  await runIn(root, ['attach'], { PW_STUB_LIST: listFile(root, []) })
  assert.equal(fs.readFileSync(markerFor(root), 'utf8').trim(), 'chrome')
})

test('attach takes the channel as a plain argument, not --browser, and says so rather than silently defaulting', async () => {
  const root = mkroot()
  const r = await runIn(root, ['attach', '--browser', 'msedge'], { PW_STUB_LIST: listFile(root, []) })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /takes the extension channel as a plain argument, not --browser/)
  assert.equal(fs.existsSync(markerFor(root)), false)
})

test('attach refuses when a normal, pwx-launched session is already live', async () => {
  const root = mkroot()
  const lf = listFile(root, [row('pw-sess1', { headed: true })])
  const r = await runIn(root, ['attach'], { PW_STUB_LIST: lf })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /already has a browser open that pwx launched itself/)
  assert.equal(fs.existsSync(markerFor(root)), false)
})

test('attach refuses to switch channel while already attached to a different one', async () => {
  const root = mkroot()
  markAttached(root, 'chrome')
  const r = await runIn(root, ['attach', 'msedge'], { PW_STUB_LIST: listFile(root, [row('pw-sess1', { headed: true })]) })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /already attached to chrome/)
})

test('re-running attach with the same channel while still connected is a no-op that says so', async () => {
  const root = mkroot()
  markAttached(root, 'chrome')
  const r = await runIn(root, ['attach'], { PW_STUB_LIST: listFile(root, [row('pw-sess1', { headed: true })]) })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /already attached to your real chrome browser/)
  assert.ok(!r.calls.some(c => c.argv.includes('attach')), 'must not re-run the engine attach call when already connected')
})

test('attach warns plainly when no token is set, rather than appearing to hang', async () => {
  const root = mkroot()
  const r = await runIn(root, ['attach'], { PW_STUB_LIST: listFile(root, []), PLAYWRIGHT_MCP_EXTENSION_TOKEN: '' })
  assert.match(r.stderr, /no PLAYWRIGHT_MCP_EXTENSION_TOKEN set/)
  assert.match(r.stderr, /approve/i)
})

test('attach does not warn, log, or print the token when one is set', async () => {
  const root = mkroot()
  const token = 'super-secret-test-token-value'
  const r = await runIn(root, ['attach'], { PW_STUB_LIST: listFile(root, []), PLAYWRIGHT_MCP_EXTENSION_TOKEN: token })
  assert.doesNotMatch(r.stderr, /PLAYWRIGHT_MCP_EXTENSION_TOKEN set/)
  assert.ok(!r.stdout.includes(token), 'the token must never be printed to stdout')
  assert.ok(!r.stderr.includes(token), 'the token must never be printed to stderr')
  assert.ok(!fs.readFileSync(markerFor(root), 'utf8').includes(token), 'the token must never be written to the session marker')
})

// --- ordinary verbs stay ordinary once attached ---

test('an ordinary verb in an attached session passes through unchanged, without repeating --extension', async () => {
  const root = mkroot()
  markAttached(root, 'chrome')
  const r = await runIn(root, ['goto', 'https://example.test'], { PW_STUB_LIST: listFile(root, [row('pw-sess1', { headed: true })]) })
  assert.deepEqual(r.calls.at(-1).argv, ['-s=pw-sess1', 'goto', 'https://example.test'])
})

test('open on a live attached session navigates normally, same as any other live session', async () => {
  const root = mkroot()
  markAttached(root, 'chrome')
  const lf = listFile(root, [row('pw-sess1', { headed: true })])
  const r = await runIn(root, ['open', 'https://example.test'], { PW_STUB_LIST: lf })
  assert.equal(r.code, 0, r.stderr)
  assert.ok(r.calls.some(c => c.argv[1] === 'goto'))
})

test('open refuses to launch a browser of its own for a disconnected attached session, and never attempts it', async () => {
  const root = mkroot()
  markAttached(root, 'chrome')
  const r = await runIn(root, ['open', 'https://example.test'], { PW_STUB_LIST: listFile(root, []) })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /no longer connected/)
  assert.match(r.stderr, /pwx attach/)
  assert.ok(!r.calls.some(c => c.argv.includes('open')), 'must never launch a browser of its own for an attached session')
})

// --- end detaches; never closes/kills ---

test('end in attach mode detaches, never closes or captures, and clears the marker', async () => {
  const root = mkroot()
  markAttached(root, 'chrome')
  // A stray profile directory should not matter: attach mode must never look
  // at it, let alone touch it.
  write(path.join(root, 'sessions', 'sess1', 'profile', 'Default', 'Cookies'), 'c')
  const r = await runIn(root, ['end'], { PW_STUB_LIST: listFile(root, [row('pw-sess1', { headed: true, attached: true })]) })
  assert.equal(r.code, 0, r.stderr)
  assert.ok(r.calls.some(c => c.argv.includes('detach')), `expected a detach call; got ${JSON.stringify(r.calls.map(c => c.argv))}`)
  assert.ok(!r.calls.some(c => c.argv.includes('close')), 'end must not close an attached session')
  assert.ok(!r.calls.some(c => c.argv.includes('state-save')), 'end must not capture storage state for an attached session')
  assert.equal(fs.existsSync(markerFor(root)), false, 'the attached marker must be cleared')
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'sess1', 'profile', 'Default', 'Cookies')), true, 'a stray profile must be left alone')
  assert.match(r.stdout, /detached/)
  assert.match(r.stdout, /untouched and still running/)
})

test('end in attach mode still clears the marker and reports success even when detach itself fails', async () => {
  const root = mkroot()
  markAttached(root, 'chrome')
  const r = await runIn(root, ['end'], { PW_STUB_LIST: listFile(root, []), PW_STUB_FAIL_VERBS: 'detach' })
  assert.equal(r.code, 0)
  assert.equal(fs.existsSync(markerFor(root)), false)
  assert.match(r.stderr, /your browser was not touched either way/)
})

// --- status and gc report attach state, without profile/golden paths ---

test('status on an attached session reports ATTACHED and omits profile/golden paths', async () => {
  const root = mkroot()
  markAttached(root, 'chrome')
  const r = await runIn(root, ['status'], { PW_STUB_LIST: listFile(root, [row('pw-sess1', { headed: true })]) })
  assert.match(r.stdout, /ATTACHED to your real chrome browser/)
  assert.match(r.stdout, /state: attached and connected/)
  assert.doesNotMatch(r.stdout, /profile:/)
  assert.doesNotMatch(r.stdout, /golden:/)
})

test('status on a disconnected attached session says so, without offering to reap anything', async () => {
  const root = mkroot()
  markAttached(root, 'chrome')
  const r = await runIn(root, ['status'], { PW_STUB_LIST: listFile(root, []) })
  assert.match(r.stdout, /ATTACHED to your real chrome browser/)
  assert.match(r.stdout, /not connected/)
})

test('gc on a connected attached session does nothing and does not claim to have cleaned anything', async () => {
  const root = mkroot()
  markAttached(root, 'chrome')
  const r = await runIn(root, ['gc'], { PW_STUB_LIST: listFile(root, [row('pw-sess1', { headed: true })]) })
  assert.match(r.stdout, /nothing to clean/)
  assert.doesNotMatch(r.stdout, /cleaned up/)
})

test('gc on a disconnected attached session reports it plainly and does not claim to have reaped a browser', async () => {
  const root = mkroot()
  markAttached(root, 'chrome')
  write(path.join(root, 'sessions', 'sess1', 'profile', 'Default', 'Cookies'), 'c')
  const r = await runIn(root, ['gc'], { PW_STUB_LIST: listFile(root, []) })
  assert.match(r.stdout, /not currently connected/)
  assert.doesNotMatch(r.stdout, /cleaned up/)
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'sess1', 'profile', 'Default', 'Cookies')), true)
})

// --- every verb whose meaning depends on owning the profile refuses outright ---

for (const [cmd, args] of [['fresh', ['https://e.test']], ['show', []], ['hide', []], ['promote', []], ['forget', []], ['logout', []]]) {
  test(`'${cmd}' refuses outright in attach mode and touches nothing`, async () => {
    const root = mkroot()
    markAttached(root, 'chrome')
    write(path.join(root, 'sessions', 'sess1', 'profile', 'Default', 'Cookies'), 'c')
    write(path.join(root, 'golden', 'chromium', 'Default', 'Cookies'), 'g')
    const r = await runIn(root, [cmd, ...args], { PW_STUB_LIST: listFile(root, [row('pw-sess1', { headed: true })]) })
    assert.equal(r.code, 2, `expected '${cmd}' to refuse (exit 2); got ${r.code}, stderr: ${r.stderr}`)
    assert.match(r.stderr, /attached to your real chrome browser/)
    assert.equal(r.calls.length, 0, `'${cmd}' must refuse before making any engine call; got ${JSON.stringify(r.calls.map(c => c.argv))}`)
    assert.equal(fs.existsSync(path.join(root, 'sessions', 'sess1', 'profile', 'Default', 'Cookies')), true, `'${cmd}' must not touch the (stray) session profile`)
    assert.equal(fs.existsSync(path.join(root, 'golden', 'chromium', 'Default', 'Cookies')), true, `'${cmd}' must not touch the golden profile`)
    assert.equal(fs.readFileSync(markerFor(root), 'utf8').trim(), 'chrome', `'${cmd}' must not clear the attached marker`)
  })
}

test("scoped 'nuke' refuses outright in attach mode", async () => {
  const root = mkroot()
  markAttached(root, 'chrome')
  write(path.join(root, 'sessions', 'sess1', 'profile', 'Default', 'Cookies'), 'c')
  const r = await runIn(root, ['nuke'], { PW_STUB_LIST: listFile(root, [row('pw-sess1', { headed: true })]) })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /there is nothing pwx-owned to reset/)
  assert.equal(r.calls.length, 0)
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'sess1', 'profile', 'Default', 'Cookies')), true)
})

test("'nuke --all' does not touch this session's (nonexistent) profile browsers while attached, and leaves the marker alone", async () => {
  const root = mkroot()
  markAttached(root, 'chrome')
  const r = await runIn(root, ['nuke', '--all'], { PW_STUB_LIST: listFile(root, []) })
  assert.equal(r.code, 0, r.stderr)
  assert.ok(r.calls.some(c => c.argv.includes('kill-all')))
  assert.equal(fs.readFileSync(markerFor(root), 'utf8').trim(), 'chrome')
})
