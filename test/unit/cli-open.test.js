import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { row, listFile } from './list-fixture.js'

const CLI = path.resolve('bin/pwx.js')
const STUB = path.resolve('test/stub/playwright-cli.js')

function runCli (args, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-cli-'))
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
      resolve({ code: err?.code ?? 0, stdout, stderr, calls, root })
    })
  })
}

test('open with no live session launches with the persistent profile', async () => {
  const pre = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-pre-'))
  const lf = listFile(pre, [])
  const r = await runCli(['open', 'https://example.test'], { PW_STUB_LIST: lf })
  const openCall = r.calls.find(c => c.argv.includes('open'))
  assert.ok(openCall, 'expected an open call')
  assert.deepEqual(openCall.argv.slice(0, 4), ['-s=pw-sess1', 'open', '--browser', 'chromium'])
  assert.ok(openCall.argv.includes('--persistent'))
  assert.ok(openCall.argv.includes('https://example.test'))
  assert.equal(openCall.env.PLAYWRIGHT_MCP_HEADLESS, 'false')
})

test('open with --browser firefox launches firefox and records it', async () => {
  const pre = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-pre-'))
  const lf = listFile(pre, [])
  const r = await runCli(['open', '--browser', 'firefox', 'https://example.test'], { PW_STUB_LIST: lf })
  const openCall = r.calls.find(c => c.argv.includes('open'))
  assert.ok(openCall.argv.includes('firefox'))
  assert.equal(fs.readFileSync(path.join(r.root, 'sessions', 'sess1', 'browser'), 'utf8').trim(), 'firefox')
})

test('open on a live session navigates instead of relaunching', async () => {
  const pre = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-pre-'))
  const lf = listFile(pre, [row('pw-sess1', { headed: true })])
  const r = await runCli(['open', 'https://example.test'], { PW_STUB_LIST: lf })
  assert.ok(r.calls.some(c => c.argv[1] === 'goto'))
  assert.ok(!r.calls.some(c => c.argv[1] === 'open'))
})

test('open refuses when the session state is unknown', async () => {
  const r = await runCli(['open', 'https://example.test'], { PW_STUB_EXIT: '4' })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /cannot tell whether your browser is running/)
})

test('open refuses an export download URL on chromium', async () => {
  const r = await runCli(['open', 'https://d.test/x/export?format=csv'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /refusing download URL/)
})

test('switching browser mid-session is an error', async () => {
  const pre = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-pre-'))
  const lf = listFile(pre, [])
  const first = await runCli(['open', '--browser', 'firefox', 'https://e.test'], { PW_STUB_LIST: lf })
  const r = await new Promise(resolve => {
    execFile(process.execPath, [CLI, 'open', '--browser', 'chromium', 'https://e.test'], {
      env: { ...process.env, PW_BIN: STUB, PW_STATE_ROOT: first.root, PW_SCRATCH_DIR: path.join(first.root, 'scratch'), CLAUDE_CODE_SESSION_ID: 'sess1', PW_STUB_LIST: lf }
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stderr }))
  })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /already running firefox/)
})

test('switching to a real-browser channel mid-session is an error, same guard as chromium/firefox', async () => {
  const pre = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-pre-'))
  const lf = listFile(pre, [])
  const first = await runCli(['open', '--browser', 'chrome', 'https://e.test'], { PW_STUB_LIST: lf })
  const r = await new Promise(resolve => {
    execFile(process.execPath, [CLI, 'open', '--browser', 'msedge', 'https://e.test'], {
      env: { ...process.env, PW_BIN: STUB, PW_STATE_ROOT: first.root, PW_SCRATCH_DIR: path.join(first.root, 'scratch'), CLAUDE_CODE_SESSION_ID: 'sess1', PW_STUB_LIST: lf }
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stderr }))
  })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /already running chrome/)
})

test('open with --browser chrome launches the chrome channel and records it', async () => {
  const pre = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-pre-'))
  const lf = listFile(pre, [])
  const r = await runCli(['open', '--browser', 'chrome', 'https://example.test'], { PW_STUB_LIST: lf })
  const openCall = r.calls.find(c => c.argv.includes('open'))
  assert.ok(openCall.argv.includes('chrome'))
  assert.equal(fs.readFileSync(path.join(r.root, 'sessions', 'sess1', 'browser'), 'utf8').trim(), 'chrome')
})

test('open with --browser msedge launches the msedge channel and records it', async () => {
  const pre = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-pre-'))
  const lf = listFile(pre, [])
  const r = await runCli(['open', '--browser', 'msedge', 'https://example.test'], { PW_STUB_LIST: lf })
  const openCall = r.calls.find(c => c.argv.includes('open'))
  assert.ok(openCall.argv.includes('msedge'))
  assert.equal(fs.readFileSync(path.join(r.root, 'sessions', 'sess1', 'browser'), 'utf8').trim(), 'msedge')
})

test('opening on the chrome channel on macOS prints the replayd warning once; chromium does not', async () => {
  const preC = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-pre-'))
  const chromeRun = await runCli(['open', '--browser', 'chrome', 'https://example.test'], { PW_STUB_LIST: listFile(preC, []) })
  const preM = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-pre-'))
  const chromiumRun = await runCli(['open', 'https://example.test'], { PW_STUB_LIST: listFile(preM, []) })
  if (process.platform === 'darwin') {
    assert.match(chromeRun.stderr, /replayd/)
    assert.equal((chromeRun.stderr.match(/replayd/g) || []).length, 1)
    assert.doesNotMatch(chromiumRun.stderr, /replayd/)
  } else {
    assert.doesNotMatch(chromeRun.stderr, /replayd/)
    assert.doesNotMatch(chromiumRun.stderr, /replayd/)
  }
})

test('unknown verbs pass through with the session flag', async () => {
  const r = await runCli(['snapshot'])
  assert.deepEqual(r.calls.at(-1).argv, ['-s=pw-sess1', 'snapshot'])
})

test('list passes through without the session flag', async () => {
  const r = await runCli(['list'])
  assert.deepEqual(r.calls.at(-1).argv, ['list'])
})

test('open warns when a cached launch-option record cannot be read', async () => {
  // clearSessionCache's skipped count exists so a caller can tell the user
  // which cached-launch-option record it could not read; a headed/headless
  // switch silently does nothing for that session if nothing surfaces it.
  const pre = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-pre-'))
  const lf = listFile(pre, [])
  const daemon = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-daemon-'))
  fs.writeFileSync(path.join(daemon, 'pw-sess1.session'), '{ not valid json')
  const r = await runCli(['open', 'https://example.test'], { PW_STUB_LIST: lf, PWTEST_DAEMON_SESSION_DIR: daemon })
  assert.match(r.stderr, /could not read 1 cached launch-option record/)
  assert.ok(r.stderr.includes(daemon), 'warning should name the daemon directory')
})
