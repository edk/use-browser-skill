import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sessionKey, daemonDir, resolve, ATTACH_SESSION_NAME } from '../../lib/config.js'

const HOME = '/home/u'

test('sessionKey strips and truncates', () => {
  assert.equal(sessionKey({ CLAUDE_CODE_SESSION_ID: 'ab-cd_ef.gh12345678' }), 'abcdefgh1234')
  assert.equal(sessionKey({}), '')
})

test('daemonDir per OS', () => {
  assert.equal(daemonDir({}, 'darwin', HOME), path.join(HOME, 'Library', 'Caches', 'ms-playwright', 'daemon'))
  assert.equal(daemonDir({}, 'linux', HOME), path.join(HOME, '.cache', 'ms-playwright', 'daemon'))
  assert.equal(daemonDir({ XDG_CACHE_HOME: '/xdg' }, 'linux', HOME), path.join('/xdg', 'ms-playwright', 'daemon'))
  assert.equal(
    daemonDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', HOME),
    path.join('C:\\Users\\u\\AppData\\Local', 'ms-playwright', 'daemon')
  )
  assert.equal(daemonDir({ PWTEST_DAEMON_SESSION_DIR: '/test/daemon' }, 'linux', HOME), '/test/daemon')
})

test('isolated session gets its own dirs', () => {
  const ctx = resolve({
    env: { CLAUDE_CODE_SESSION_ID: 'abc123', PW_STATE_ROOT: '/s' },
    platform: 'linux', homedir: HOME
  })
  assert.equal(ctx.isolated, true)
  assert.equal(ctx.session, 'pw-abc123')
  assert.equal(ctx.stateDir, path.join('/s', 'sessions', 'abc123'))
  assert.equal(ctx.profileDir, path.join('/s', 'sessions', 'abc123', 'profile'))
  assert.equal(ctx.goldenDir, path.join('/s', 'golden', 'chromium'))
})

test('no session id falls back to the shared profile', () => {
  const ctx = resolve({ env: { PW_STATE_ROOT: '/s' }, platform: 'linux', homedir: HOME })
  assert.equal(ctx.isolated, false)
  assert.equal(ctx.session, 'pw')
  assert.equal(ctx.profileDir, path.join('/s', 'profile'))
})

test('explicit PW_PROFILE_DIR forces shared mode', () => {
  const ctx = resolve({
    env: { CLAUDE_CODE_SESSION_ID: 'abc123', PW_PROFILE_DIR: '/p/prof', PW_STATE_ROOT: '/s' },
    platform: 'linux', homedir: HOME
  })
  assert.equal(ctx.isolated, false)
  assert.equal(ctx.session, 'pw')
  assert.equal(ctx.profileDir, '/p/prof')
})

test('browser precedence: flag over env over session over config over default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-c-'))
  const base = { platform: 'linux', homedir: HOME }
  assert.equal(resolve({ ...base, env: { PW_STATE_ROOT: root } }).browser, 'chromium')

  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ browser: 'firefox' }))
  let ctx = resolve({ ...base, env: { PW_STATE_ROOT: root } })
  assert.equal(ctx.browser, 'firefox')
  assert.equal(ctx.browserSource, 'config')

  const sdir = path.join(root, 'sessions', 'k1')
  fs.mkdirSync(sdir, { recursive: true })
  fs.writeFileSync(path.join(sdir, 'browser'), 'chromium\n')
  ctx = resolve({ ...base, env: { PW_STATE_ROOT: root, CLAUDE_CODE_SESSION_ID: 'k1' } })
  assert.equal(ctx.browser, 'chromium')
  assert.equal(ctx.browserSource, 'session')

  ctx = resolve({ ...base, env: { PW_STATE_ROOT: root, CLAUDE_CODE_SESSION_ID: 'k1', PW_BROWSER: 'firefox' } })
  assert.equal(ctx.browserSource, 'env')

  ctx = resolve({
    ...base,
    env: { PW_STATE_ROOT: root, CLAUDE_CODE_SESSION_ID: 'k1', PW_BROWSER: 'firefox' },
    argvBrowser: 'chromium'
  })
  assert.equal(ctx.browser, 'chromium')
  assert.equal(ctx.browserSource, 'flag')
})

test('chrome and msedge resolve to their own golden directories, distinct from chromium', () => {
  const base = { platform: 'linux', homedir: HOME, env: { PW_STATE_ROOT: '/s' } }
  const chromium = resolve(base)
  const chrome = resolve({ ...base, argvBrowser: 'chrome' })
  const msedge = resolve({ ...base, argvBrowser: 'msedge' })
  assert.equal(chrome.browser, 'chrome')
  assert.equal(chrome.goldenDir, path.join('/s', 'golden', 'chrome'))
  assert.equal(msedge.browser, 'msedge')
  assert.equal(msedge.goldenDir, path.join('/s', 'golden', 'msedge'))
  assert.notEqual(chrome.goldenDir, chromium.goldenDir)
  assert.notEqual(chrome.goldenDir, msedge.goldenDir)
})

test('an unsupported browser is rejected, naming which source it came from', () => {
  const base = { platform: 'linux', homedir: HOME, env: { PW_STATE_ROOT: '/s' } }
  assert.throws(() => resolve({ ...base, argvBrowser: 'webkit' }), /unsupported browser 'webkit' \(from flag\)/)
  assert.throws(() => resolve({ ...base, env: { ...base.env, PW_BROWSER: 'webkit' } }), /unsupported browser 'webkit' \(from env\)/)
})

test('headless follows the mode file unless the env overrides', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-m-'))
  const base = { platform: 'linux', homedir: HOME, env: { PW_STATE_ROOT: root, CLAUDE_CODE_SESSION_ID: 'k9' } }
  assert.equal(resolve(base).headless, false)
  const sdir = path.join(root, 'sessions', 'k9')
  fs.mkdirSync(sdir, { recursive: true })
  fs.writeFileSync(path.join(sdir, 'mode'), 'headless\n')
  assert.equal(resolve(base).headless, true)
  assert.equal(resolve({ ...base, env: { ...base.env, PLAYWRIGHT_MCP_HEADLESS: 'false' } }).headless, false)
})

test('attached is false and attachedChannel is null with no marker on disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-at-'))
  const ctx = resolve({ env: { PW_STATE_ROOT: root, CLAUDE_CODE_SESSION_ID: 'k9' }, platform: 'linux', homedir: HOME })
  assert.equal(ctx.attached, false)
  assert.equal(ctx.attachedChannel, null)
})

test('attached and attachedChannel are read back from the session\'s attached marker, across process invocations', () => {
  // Each `pwx <verb>` is a separate process; attach mode has to survive that
  // by being written to disk (see setAttached in lib/session.js) and read
  // back here on every later resolve(), the same way the `mode` and
  // `browser` markers already do a few lines up in this file.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-at-'))
  const sdir = path.join(root, 'sessions', 'k9')
  fs.mkdirSync(sdir, { recursive: true })
  fs.writeFileSync(path.join(sdir, 'attached'), 'chrome\n')
  const ctx = resolve({ env: { PW_STATE_ROOT: root, CLAUDE_CODE_SESSION_ID: 'k9' }, platform: 'linux', homedir: HOME })
  assert.equal(ctx.attached, true)
  assert.equal(ctx.attachedChannel, 'chrome')
})

test('an attached session\'s engine session name is the one fixed, shared constant, not its per-agent name', () => {
  // The whole point of attach mode is that any Claude session can join the
  // same real-browser connection with no coordination. A second agent (a
  // different CLAUDE_CODE_SESSION_ID, hence a different per-agent stateDir)
  // that has also attached must resolve to the exact same ctx.session as
  // this one, so both reach the same playwright-cli session.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-at-'))
  const sdirA = path.join(root, 'sessions', 'agentA')
  const sdirB = path.join(root, 'sessions', 'agentB')
  fs.mkdirSync(sdirA, { recursive: true }); fs.writeFileSync(path.join(sdirA, 'attached'), 'chrome\n')
  fs.mkdirSync(sdirB, { recursive: true }); fs.writeFileSync(path.join(sdirB, 'attached'), 'chrome\n')
  const ctxA = resolve({ env: { PW_STATE_ROOT: root, CLAUDE_CODE_SESSION_ID: 'agentA' }, platform: 'linux', homedir: HOME })
  const ctxB = resolve({ env: { PW_STATE_ROOT: root, CLAUDE_CODE_SESSION_ID: 'agentB' }, platform: 'linux', homedir: HOME })
  assert.equal(ctxA.session, ATTACH_SESSION_NAME)
  assert.equal(ctxB.session, ATTACH_SESSION_NAME)
  assert.equal(ctxA.session, ctxB.session)
  // Each agent's own per-agent identity, and its local bookkeeping
  // directory, stay distinct regardless — only the engine-facing session
  // name is unified.
  assert.equal(ctxA.ownSession, 'pw-agentA')
  assert.equal(ctxB.ownSession, 'pw-agentB')
  assert.notEqual(ctxA.stateDir, ctxB.stateDir)
})

test('an unattached session keeps its own per-agent engine session name, unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-at-'))
  const ctx = resolve({ env: { PW_STATE_ROOT: root, CLAUDE_CODE_SESSION_ID: 'k9' }, platform: 'linux', homedir: HOME })
  assert.equal(ctx.session, 'pw-k9')
  assert.equal(ctx.ownSession, 'pw-k9')
})

test('PW_CACHE_DIR is ignored: it is the live bash tool\'s state root, not ours', () => {
  // A user with PW_CACHE_DIR exported pointed pwx at bin/pw's state directory.
  // The first isolated open ran the golden migration there and broke the bash
  // tool's seeding, and both tools then shared one session profile, so pwx's
  // reaper killed the bash tool's live browser.
  const ctx = resolve({ env: { PW_CACHE_DIR: '/legacy' }, platform: 'linux', homedir: HOME })
  assert.equal(ctx.stateRoot, path.join(HOME, '.cache', 'pwx'))
  assert.equal(ctx.profileDir, path.join(HOME, '.cache', 'pwx', 'profile'))
})

test('a malformed PW_SESSION_TTL_DAYS falls back to the default instead of NaN', () => {
  // NaN compares false against every age, so sweepStale deleted every idle
  // unlisted session profile on the machine regardless of how recent it was.
  const at = v => resolve({
    env: { PW_STATE_ROOT: '/s', PW_SESSION_TTL_DAYS: v }, platform: 'linux', homedir: HOME
  }).ttlDays
  for (const bad of ['abc', '', '   ', '-1', 'NaN', 'Infinity', '7d', '{}']) {
    assert.equal(at(bad), 7, `PW_SESSION_TTL_DAYS=${JSON.stringify(bad)}`)
  }
  assert.equal(resolve({ env: { PW_STATE_ROOT: '/s' }, platform: 'linux', homedir: HOME }).ttlDays, 7)
  assert.equal(at('0'), 0, 'an explicit zero is a real choice, not a typo')
  assert.equal(at('30'), 30)
  assert.equal(at('0.5'), 0.5)
})
