# pwx Node Port Implementation Plan

> **Historical record.** This document records the plan as written before
> execution. Execution superseded parts of it — notably an environment
> variable alias that was deliberately removed for safety, and a
> rendered-text `list` output parser (and its tests) that were deleted in
> favor of parsing the CLI's `--json` output. It is kept as-is rather than
> rewritten. `docs/2026-09-08-pwx-node-port-design.md` and the shipped code
> in `bin/` and `lib/` are authoritative; do not reintroduce anything this
> document describes that the code no longer does.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `bin/pw` (bash, Chromium, macOS only) to Node as `pwx`, running Chromium and Firefox on macOS, Ubuntu, and native Windows 10, with the same command surface.

**Architecture:** `pwx` is a thin Node CLI over a pinned `@playwright/cli`. It owns session keying, per-session profile seeding from a per-browser golden profile, promotion back to golden, orphan browser reaping, and clearing playwright-cli's cached headless flag. Browser differences live behind a two-method-plus-data adapter interface. OS differences live in two modules: `lib/config.js` for paths and `lib/procs.js` for process listing and signals.

**Tech Stack:** Node 20+, ESM, `node:test`, `@playwright/cli` (pinned), GitHub Actions. No other dependencies.

**Spec:** `docs/2026-09-08-pwx-node-port-design.md`

## Global Constraints

- Node >= 20. `package.json` sets `"engines": {"node": ">=20"}` and `"type": "module"`.
- Zero runtime dependencies except `@playwright/cli`, pinned to an exact version (no `^`).
- Never published to npm. `package.json` sets `"private": true`.
- Development binary name is `pwx`. Development state root is `~/.cache/pwx`. Development scratch dir is `<os.tmpdir()>/pwx`. The live bash `pw`, `~/.cache/pw-cli`, and `<tmpdir>/pw-cli` must never be read for writes or written to by `pwx` during development.
- No python3 dependency anywhere. No `ps` on Windows. No WMIC.
- Supported browsers: `chromium` and `firefox` only. Default `chromium`.
- All user-facing messages keep the `pw: ` prefix used by the current tool.
- Env var names carry over unchanged: `PW_BIN`, `PW_SCRATCH_DIR`, `PW_CACHE_DIR`, `PW_PROFILE_DIR`, `PW_GOLDEN_DIR`, `PW_EPHEMERAL`, `PW_SEED`, `PW_SESSION_TTL_DAYS`, `PW_SESSION`, `PW_BROWSER`, `PLAYWRIGHT_MCP_HEADLESS`, `CLAUDE_CODE_SESSION_ID`. New: `PW_STATE_ROOT` (preferred name for the root; `PW_CACHE_DIR` remains an accepted alias). The spec calls this `PW_STATE_DIR`; that name is not used because in the bash tool `PW_STATE_DIR` means the per-session directory, and reusing it would silently change meaning for anyone with it exported.
- Every profile copy excludes the adapter's `pruneDirs` and deletes the adapter's `lockFiles` in the destination.
- Never delete or launch over a profile that has a live process on it.

---

## File Structure

| File | Responsibility |
|---|---|
| `bin/pwx.js` | Entry point. Arg parsing, dispatch, all verb implementations, passthrough. |
| `lib/config.js` | Session key, config file, env precedence, state root, per-OS daemon dir, context object. |
| `lib/procs.js` | OS primitives only: list processes, test liveness, kill with escalation. |
| `lib/browsers/index.js` | Adapter registry. |
| `lib/browsers/chromium.js` | Chromium lock names, prune list, prefs fix, cookie count, argv matcher. |
| `lib/browsers/firefox.js` | Same interface for Firefox. |
| `lib/engine.js` | Resolve and spawn playwright-cli, parse `list`, clear stale `.session` records. |
| `lib/session.js` | Profile copy, seed, promote, sweep, golden migration, profile-scoped reaping, last-used. |
| `lib/menu.js` | Interactive numbered picker. |
| `test/stub/playwright-cli.js` | Fake engine that records argv and env and replays canned `list` output. |
| `test/unit/*.test.js` | One file per lib module plus one for the CLI. |
| `test/integration/*.test.js` | Real headless browsers against a local HTTP server. |
| `.github/workflows/ci.yml` | ubuntu/windows/macos by Node 20/22. |
| `docs/manual-verification.md` | Headed checklist for the LAN Windows 10 and Ubuntu machines. |

`bin/pw`, `install.sh`, and `test/run.sh` are left untouched by this plan. They are handled at cutover, which is out of scope here.

---

### Task 1: Scaffold, pinned engine, stub, and CI

**Files:**
- Create: `package.json`, `.gitignore` (append), `test/stub/playwright-cli.js`, `test/unit/smoke.test.js`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` runs `node --test test/unit/`. Stub protocol: the stub appends one JSON line per invocation to the file named by `PW_STUB_LOG` with shape `{"argv": string[], "env": {"PLAYWRIGHT_MCP_HEADLESS": string, "PLAYWRIGHT_MCP_OUTPUT_DIR": string}, "cwd": string}`, prints the contents of the file named by `PW_STUB_LIST` when argv[0] is `list`, and exits with the integer in `PW_STUB_EXIT` (default 0).

- [ ] **Step 1: Write package.json**

```json
{
  "name": "pwx",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Per-session browser wrapper over @playwright/cli",
  "bin": { "pwx": "bin/pwx.js" },
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test test/unit/",
    "test:integration": "node --test test/integration/"
  },
  "dependencies": {
    "@playwright/cli": "0.1.19"
  }
}
```

- [ ] **Step 2: Write the stub engine**

Create `test/stub/playwright-cli.js`:

```js
#!/usr/bin/env node
import fs from 'node:fs'

const argv = process.argv.slice(2)
const log = process.env.PW_STUB_LOG
if (log) {
  fs.appendFileSync(log, JSON.stringify({
    argv,
    env: {
      PLAYWRIGHT_MCP_HEADLESS: process.env.PLAYWRIGHT_MCP_HEADLESS ?? '',
      PLAYWRIGHT_MCP_OUTPUT_DIR: process.env.PLAYWRIGHT_MCP_OUTPUT_DIR ?? ''
    },
    cwd: process.cwd()
  }) + '\n')
}
if (argv[0] === 'list' && process.env.PW_STUB_LIST) {
  process.stdout.write(fs.readFileSync(process.env.PW_STUB_LIST, 'utf8'))
}
process.exit(Number(process.env.PW_STUB_EXIT ?? 0))
```

- [ ] **Step 3: Write the smoke test**

Create `test/unit/smoke.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

test('stub records argv and env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-t-'))
  const log = path.join(dir, 'log')
  execFileSync(process.execPath, ['test/stub/playwright-cli.js', 'list', '-s=pw-x'], {
    env: { ...process.env, PW_STUB_LOG: log, PLAYWRIGHT_MCP_HEADLESS: 'true' }
  })
  const rec = JSON.parse(fs.readFileSync(log, 'utf8').trim())
  assert.deepEqual(rec.argv, ['list', '-s=pw-x'])
  assert.equal(rec.env.PLAYWRIGHT_MCP_HEADLESS, 'true')
})
```

- [ ] **Step 4: Run the test**

Run: `npm install && npm test`
Expected: PASS, 1 test.

- [ ] **Step 5: Write the CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: ci
on: [push, pull_request]
jobs:
  unit:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        node: [20, 22]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: npm install
      - run: npm test
  integration:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install
      - name: Install browsers
        run: |
          node node_modules/@playwright/cli/cli.js install-browser chromium --with-deps
          node node_modules/@playwright/cli/cli.js install-browser firefox --with-deps
      - run: npm run test:integration
        env:
          PWX_INTEGRATION: '1'
```

Note: the exact path to the CLI entry is confirmed in Task 5 Step 1. If it differs, fix it here in the same commit as Task 5.

- [ ] **Step 6: Append to .gitignore**

```
node_modules/
package-lock.json
```

- [ ] **Step 7: Commit**

```bash
git add package.json .gitignore test/stub/playwright-cli.js test/unit/smoke.test.js .github/workflows/ci.yml
git commit -m "feat(pwx): scaffold Node port with pinned playwright-cli, stub engine, and three-OS CI"
```

---

### Task 2: lib/config.js — session key, paths, precedence

**Files:**
- Create: `lib/config.js`
- Test: `test/unit/config.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `sessionKey(env) -> string` — `env.CLAUDE_CODE_SESSION_ID` with non-alphanumerics removed, truncated to 12 chars, `''` when absent.
  - `workspaceHash(dir) -> string` — sha1 hex of `dir`.
  - `daemonDir(env, platform, homedir, workspaceDir) -> string`
  - `configPath(stateRoot) -> string`
  - `loadConfigFile(stateRoot) -> {browser?, headed?, stateDir?}`
  - `resolve({env, platform, homedir, argvBrowser}) -> Ctx` where Ctx is `{bin, scratchDir, stateRoot, isolated, sessionKey, session, stateDir, profileDir, goldenDir, browser, browserSource, headless, ephemeral, seed, ttlDays, daemonDir}`
  - `SOURCES` order for `pwx config`: `['flag','env','session','config','default']`

- [ ] **Step 1: Write the failing test**

Create `test/unit/config.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sessionKey, daemonDir, resolve } from '../../lib/config.js'

const HOME = '/home/u'

test('sessionKey strips and truncates', () => {
  assert.equal(sessionKey({ CLAUDE_CODE_SESSION_ID: 'ab-cd_ef.gh12345678' }), 'abcdefgh1234')
  assert.equal(sessionKey({}), '')
})

test('daemonDir per OS', () => {
  const w = '/tmp/pwx'
  assert.match(daemonDir({}, 'darwin', HOME, w), /^\/home\/u\/Library\/Caches\/ms-playwright\/daemon\//)
  assert.match(daemonDir({}, 'linux', HOME, w), /^\/home\/u\/\.cache\/ms-playwright\/daemon\//)
  assert.match(daemonDir({ XDG_CACHE_HOME: '/xdg' }, 'linux', HOME, w), /^\/xdg\/ms-playwright\/daemon\//)
  assert.match(
    daemonDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', HOME, w),
    /ms-playwright[\\/]daemon[\\/]/
  )
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

test('PW_CACHE_DIR is accepted as the state root alias', () => {
  const ctx = resolve({ env: { PW_CACHE_DIR: '/legacy' }, platform: 'linux', homedir: HOME })
  assert.equal(ctx.stateRoot, '/legacy')
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/unit/config.test.js`
Expected: FAIL, cannot find module `../../lib/config.js`.

- [ ] **Step 3: Implement lib/config.js**

```js
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const BROWSERS = ['chromium', 'firefox']
export const SOURCES = ['flag', 'env', 'session', 'config', 'default']

export function sessionKey (env) {
  return String(env.CLAUDE_CODE_SESSION_ID ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)
}

export function workspaceHash (dir) {
  return crypto.createHash('sha1').update(dir).digest('hex')
}

// Mirrors playwright-core/lib/tools/cli-client/registry.js so we look in the
// same place the daemon writes. A wrong path here is silent: the cached
// headless flag is never cleared and `pw show` stops working.
export function daemonDir (env, platform, homedir, workspaceDir) {
  let base
  if (platform === 'win32') base = env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local')
  else if (platform === 'darwin') base = path.join(homedir, 'Library', 'Caches')
  else base = env.XDG_CACHE_HOME || path.join(homedir, '.cache')
  if (env.PWTEST_DAEMON_SESSION_DIR) return env.PWTEST_DAEMON_SESSION_DIR
  return path.join(base, 'ms-playwright', 'daemon', workspaceHash(workspaceDir))
}

export function configPath (stateRoot) {
  return path.join(stateRoot, 'config.json')
}

export function loadConfigFile (stateRoot) {
  try {
    return JSON.parse(fs.readFileSync(configPath(stateRoot), 'utf8'))
  } catch {
    return {}
  }
}

function readTrimmed (file) {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

export function resolve ({ env = process.env, platform = process.platform, homedir = os.homedir(), argvBrowser = null, tmpdir = os.tmpdir() } = {}) {
  const cfgRootGuess = env.PW_STATE_ROOT || env.PW_CACHE_DIR || path.join(homedir, '.cache', 'pwx')
  const fileCfg = loadConfigFile(cfgRootGuess)
  const stateRoot = env.PW_STATE_ROOT || env.PW_CACHE_DIR || fileCfg.stateDir || path.join(homedir, '.cache', 'pwx')
  const cfg = (stateRoot === cfgRootGuess) ? fileCfg : loadConfigFile(stateRoot)

  const key = sessionKey(env)
  let isolated, session, stateDir, profileDir
  if (env.PW_PROFILE_DIR) {
    isolated = false
    session = env.PW_SESSION || 'pw'
    stateDir = path.dirname(env.PW_PROFILE_DIR)
    profileDir = env.PW_PROFILE_DIR
  } else if (key) {
    isolated = true
    session = env.PW_SESSION || `pw-${key}`
    stateDir = path.join(stateRoot, 'sessions', key)
    profileDir = path.join(stateDir, 'profile')
  } else {
    isolated = false
    session = env.PW_SESSION || 'pw'
    stateDir = stateRoot
    profileDir = path.join(stateRoot, 'profile')
  }

  const recorded = readTrimmed(path.join(stateDir, 'browser'))
  let browser = 'chromium'
  let browserSource = 'default'
  if (argvBrowser) { browser = argvBrowser; browserSource = 'flag' } else if (env.PW_BROWSER) { browser = env.PW_BROWSER; browserSource = 'env' } else if (recorded) { browser = recorded; browserSource = 'session' } else if (cfg.browser) { browser = cfg.browser; browserSource = 'config' }
  if (!BROWSERS.includes(browser)) {
    throw new Error(`pw: unsupported browser '${browser}' (from ${browserSource}). Use one of: ${BROWSERS.join(', ')}`)
  }

  let headless
  if (env.PLAYWRIGHT_MCP_HEADLESS !== undefined && env.PLAYWRIGHT_MCP_HEADLESS !== '') {
    headless = env.PLAYWRIGHT_MCP_HEADLESS === 'true'
  } else {
    const mode = readTrimmed(path.join(stateDir, 'mode'))
    headless = mode ? mode === 'headless' : (cfg.headed === false)
  }

  const scratchDir = env.PW_SCRATCH_DIR || path.join(tmpdir, 'pwx')
  return {
    bin: env.PW_BIN || null,
    scratchDir,
    stateRoot,
    isolated,
    sessionKey: key,
    session,
    stateDir,
    profileDir,
    goldenDir: env.PW_GOLDEN_DIR || path.join(stateRoot, 'golden', browser),
    browser,
    browserSource,
    headless,
    ephemeral: env.PW_EPHEMERAL === '1',
    seed: env.PW_SEED !== '0',
    ttlDays: Number(env.PW_SESSION_TTL_DAYS ?? 7),
    daemonDir: daemonDir(env, platform, homedir, scratchDir),
    config: cfg,
    platform
  }
}
```

- [ ] **Step 4: Run the test**

Run: `node --test test/unit/config.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/config.js test/unit/config.test.js
git commit -m "feat(pwx): resolve session, paths, and browser precedence per OS"
```

---

### Task 3: lib/procs.js — cross-platform process listing and kill

**Files:**
- Create: `lib/procs.js`
- Test: `test/unit/procs.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `listProcesses({platform, exec}) -> Promise<Array<{pid:number, cmdline:string}>>`
  - `parsePs(text) -> Array<{pid, cmdline}>`
  - `parseWmi(json) -> Array<{pid, cmdline}>`
  - `isAlive(pid) -> boolean`
  - `killPids(pids, {platform, graceMs=5000, sleep}) -> Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `test/unit/procs.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePs, parseWmi, listProcesses, isAlive } from '../../lib/procs.js'

test('parsePs handles paths with spaces', () => {
  const out = [
    ' 501 /Applications/My Browser.app/x --user-data-dir=/a b/prof',
    '  22 /bin/sh'
  ].join('\n')
  assert.deepEqual(parsePs(out), [
    { pid: 501, cmdline: '/Applications/My Browser.app/x --user-data-dir=/a b/prof' },
    { pid: 22, cmdline: '/bin/sh' }
  ])
})

test('parsePs skips malformed lines', () => {
  assert.deepEqual(parsePs('\n  \nnotapid stuff\n'), [])
})

test('parseWmi accepts a single object and an array and a null cmdline', () => {
  assert.deepEqual(parseWmi('{"ProcessId":4,"CommandLine":"chrome.exe --x"}'),
    [{ pid: 4, cmdline: 'chrome.exe --x' }])
  assert.deepEqual(parseWmi('[{"ProcessId":4,"CommandLine":null}]'),
    [{ pid: 4, cmdline: '' }])
})

test('listProcesses uses ps on posix and powershell on win32', async () => {
  const calls = []
  const exec = async (cmd, args) => { calls.push([cmd, args]); return '{"ProcessId":1,"CommandLine":"a"}' }
  await listProcesses({ platform: 'win32', exec })
  assert.match(calls[0][0], /powershell|pwsh/)
  assert.ok(calls[0][1].join(' ').includes('Win32_Process'))

  const calls2 = []
  const exec2 = async (cmd, args) => { calls2.push([cmd, args]); return ' 1 a' }
  await listProcesses({ platform: 'linux', exec: exec2 })
  assert.equal(calls2[0][0], 'ps')
  assert.deepEqual(calls2[0][1], ['-axo', 'pid=,args='])
})

test('listProcesses returns empty on failure rather than throwing', async () => {
  const exec = async () => { throw new Error('nope') }
  assert.deepEqual(await listProcesses({ platform: 'linux', exec }), [])
})

test('isAlive is true for this process and false for an impossible pid', () => {
  assert.equal(isAlive(process.pid), true)
  assert.equal(isAlive(0x7ffffff0), false)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/unit/procs.test.js`
Expected: FAIL, cannot find module `../../lib/procs.js`.

- [ ] **Step 3: Implement lib/procs.js**

```js
import { execFile } from 'node:child_process'

const PS_ARGS = ['-axo', 'pid=,args=']
const WMI_SCRIPT =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'

function defaultExec (cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout)
    })
  })
}

export function parsePs (text) {
  const out = []
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (m && m[2].length) out.push({ pid: Number(m[1]), cmdline: m[2] })
  }
  return out
}

export function parseWmi (json) {
  let data
  try { data = JSON.parse(json) } catch { return [] }
  if (!data) return []
  const rows = Array.isArray(data) ? data : [data]
  return rows
    .filter(r => r && Number.isFinite(Number(r.ProcessId)))
    .map(r => ({ pid: Number(r.ProcessId), cmdline: r.CommandLine ?? '' }))
}

// WMIC is removed on current Windows 10 builds, so the Windows path goes
// through CIM. Both branches swallow failures: an unreadable process table
// must read as "no matches", never as a crash mid-verb.
export async function listProcesses ({ platform = process.platform, exec = defaultExec } = {}) {
  try {
    if (platform === 'win32') {
      return parseWmi(await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WMI_SCRIPT]))
    }
    return parsePs(await exec('ps', PS_ARGS))
  } catch {
    return []
  }
}

export function isAlive (pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

const wait = ms => new Promise(r => setTimeout(r, ms))

// SIGTERM first so Chromium flushes its cookie DB (it batches writes on a ~30s
// timer; SIGKILL loses a login completed moments ago). Windows maps both
// signals to TerminateProcess, so the grace period buys nothing there.
export async function killPids (pids, { platform = process.platform, graceMs = 5000, sleep = wait } = {}) {
  if (!pids.length) return
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch {} }
  if (platform !== 'win32') {
    const deadline = Date.now() + graceMs
    while (Date.now() < deadline) {
      if (!pids.some(isAlive)) return
      await sleep(200)
    }
  }
  for (const pid of pids) { if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} } }
}
```

- [ ] **Step 4: Run the test**

Run: `node --test test/unit/procs.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/procs.js test/unit/procs.test.js
git commit -m "feat(pwx): list and kill processes on macOS, Linux, and Windows"
```

---

### Task 4: Browser adapters

**Files:**
- Create: `lib/browsers/index.js`, `lib/browsers/chromium.js`, `lib/browsers/firefox.js`
- Test: `test/unit/browsers.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `get(name) -> Adapter`, `names -> string[]`. Adapter shape:
  - `name: string`, `cliBrowser: string`
  - `lockFiles: string[]`, `pruneDirs: string[]`
  - `installArgs(platform) -> string[]`
  - `beforeLaunch(profileDir) -> Promise<void>`
  - `cookieCount(profileDir) -> Promise<number|null>` (null means "could not tell")
  - `argvMatches(cmdline, profileDir, platform) -> boolean`
  - `unsafeUrl(url) -> boolean`

- [ ] **Step 1: Write the failing test**

Create `test/unit/browsers.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { get, names } from '../../lib/browsers/index.js'

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-b-'))

test('registry exposes both browsers and rejects others', () => {
  assert.deepEqual(names, ['chromium', 'firefox'])
  assert.throws(() => get('webkit'), /unsupported browser/)
})

test('chromium argvMatches is exact, space tolerant, and rejects prefixes', () => {
  const c = get('chromium')
  const dir = '/a b/prof'
  assert.equal(c.argvMatches(`chrome --user-data-dir=${dir} --x`, dir, 'linux'), true)
  assert.equal(c.argvMatches(`chrome --user-data-dir=${dir}`, dir, 'linux'), true)
  assert.equal(c.argvMatches(`chrome --user-data-dir=${dir}-2`, dir, 'linux'), false)
  assert.equal(c.argvMatches('chrome --user-data-dir=/other', dir, 'linux'), false)
})

test('firefox argvMatches handles -profile and --profile', () => {
  const f = get('firefox')
  const dir = '/a b/prof'
  assert.equal(f.argvMatches(`firefox -profile ${dir} -foreground`, dir, 'linux'), true)
  assert.equal(f.argvMatches(`firefox --profile ${dir}`, dir, 'linux'), true)
  assert.equal(f.argvMatches(`firefox -profile ${dir}-2`, dir, 'linux'), false)
})

test('argvMatches folds case on win32 only', () => {
  const c = get('chromium')
  const dir = 'C:\\Users\\U\\prof'
  assert.equal(c.argvMatches('chrome.exe --user-data-dir=c:\\users\\u\\prof', dir, 'win32'), true)
  assert.equal(c.argvMatches('chrome --user-data-dir=/A', '/a', 'linux'), false)
})

test('chromium beforeLaunch marks the previous exit clean', async () => {
  const dir = mk()
  const prefs = path.join(dir, 'Default', 'Preferences')
  fs.mkdirSync(path.dirname(prefs), { recursive: true })
  fs.writeFileSync(prefs, JSON.stringify({ profile: { exit_type: 'Crashed', exited_cleanly: false }, keep: 1 }))
  await get('chromium').beforeLaunch(dir)
  const after = JSON.parse(fs.readFileSync(prefs, 'utf8'))
  assert.equal(after.profile.exit_type, 'Normal')
  assert.equal(after.profile.exited_cleanly, true)
  assert.equal(after.keep, 1)
})

test('chromium beforeLaunch tolerates a missing or corrupt Preferences file', async () => {
  const dir = mk()
  await get('chromium').beforeLaunch(dir)
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), 'not json')
  await get('chromium').beforeLaunch(dir)
})

test('firefox beforeLaunch writes the prefs that suppress restore and default-browser prompts', async () => {
  const dir = mk()
  await get('firefox').beforeLaunch(dir)
  const js = fs.readFileSync(path.join(dir, 'user.js'), 'utf8')
  assert.match(js, /browser\.sessionstore\.resume_from_crash", false/)
  assert.match(js, /browser\.shell\.checkDefaultBrowser", false/)
  await get('firefox').beforeLaunch(dir)
  const twice = fs.readFileSync(path.join(dir, 'user.js'), 'utf8')
  assert.equal(twice.match(/resume_from_crash/g).length, 1)
})

test('cookieCount returns null when the cookie store is absent', async () => {
  const dir = mk()
  assert.equal(await get('chromium').cookieCount(dir), null)
  assert.equal(await get('firefox').cookieCount(dir), null)
})

test('unsafeUrl only blocks export downloads and only on chromium', () => {
  const u = 'https://docs.google.com/spreadsheets/d/x/export?format=csv'
  assert.equal(get('chromium').unsafeUrl(u), true)
  assert.equal(get('chromium').unsafeUrl('https://example.com/'), false)
  assert.equal(get('firefox').unsafeUrl(u), false)
})

test('installArgs adds --with-deps on linux only', () => {
  assert.deepEqual(get('firefox').installArgs('linux'), ['install-browser', 'firefox', '--with-deps'])
  assert.deepEqual(get('firefox').installArgs('darwin'), ['install-browser', 'firefox'])
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/unit/browsers.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement the shared helpers and the Chromium adapter**

Create `lib/browsers/chromium.js`:

```js
import fs from 'node:fs'
import path from 'node:path'

// Match the profile path as a substring so a path containing spaces still
// matches, then require the next character to be a space or end of line. A
// plain substring test also matches "<dir>-2", i.e. a DIFFERENT session's
// profile, and this function decides what gets killed.
export function matchFlag (cmdline, needleValues, platform) {
  const hay = platform === 'win32' ? cmdline.toLowerCase() : cmdline
  for (const raw of needleValues) {
    const needle = platform === 'win32' ? raw.toLowerCase() : raw
    let from = 0
    for (;;) {
      const i = hay.indexOf(needle, from)
      if (i < 0) break
      const next = hay[i + needle.length]
      if (next === undefined || next === ' ') return true
      from = i + 1
    }
  }
  return false
}

export function variants (dir) {
  const out = new Set([dir, path.normalize(dir)])
  try { out.add(fs.realpathSync(dir)) } catch {}
  return [...out]
}

export default {
  name: 'chromium',
  // Chrome for Testing, not branded Chrome: two branded instances drive macOS
  // replayd into a 100-300% CPU spin (crbug.com/379347944).
  cliBrowser: 'chromium',
  lockFiles: ['SingletonLock', 'SingletonSocket', 'SingletonCookie'],
  pruneDirs: [
    'Default/Cache', 'Default/Code Cache', 'Default/Service Worker',
    'Default/GPUCache', 'Default/DawnWebGPUCache', 'Default/DawnGraphiteCache',
    'Default/Shared Dictionary', 'Default/Sessions', 'Default/History',
    'GraphiteDawnCache', 'GPUPersistentCache', 'component_crx_cache'
  ],
  installArgs (platform) {
    const a = ['install-browser', 'chromium']
    if (platform === 'linux') a.push('--with-deps')
    return a
  },
  // Playwright kills Chrome before it writes its clean-exit marker, so every
  // relaunch shows "Restore pages?". Cosmetic only; logins are flushed by the
  // CDP close regardless.
  async beforeLaunch (profileDir) {
    const prefs = path.join(profileDir, 'Default', 'Preferences')
    let data
    try { data = JSON.parse(await fs.promises.readFile(prefs, 'utf8')) } catch { return }
    data.profile = data.profile || {}
    data.profile.exit_type = 'Normal'
    data.profile.exited_cleanly = true
    const tmp = `${prefs}.pwx-tmp`
    await fs.promises.writeFile(tmp, JSON.stringify(data))
    await fs.promises.rename(tmp, prefs)
  },
  async cookieCount (profileDir) {
    return countRows(path.join(profileDir, 'Default', 'Cookies'), 'cookies')
  },
  argvMatches (cmdline, profileDir, platform = process.platform) {
    return matchFlag(cmdline, variants(profileDir).map(d => `--user-data-dir=${d}`), platform)
  },
  // These URLs crash the IPC stream mid-launch: Chrome starts and takes the
  // Singleton lock, the Node stream dies before the session registers, and
  // Chrome is left orphaned holding the profile.
  unsafeUrl (url) {
    return /\/export\?format=/.test(url)
  }
}

// node:sqlite landed in Node 22. On Node 20 we cannot read the store, so
// return null ("could not tell") rather than 0, which callers would report as
// "your promoted profile has no logins".
export async function countRows (file, table) {
  if (!fs.existsSync(file)) return null
  let DatabaseSync
  try { ({ DatabaseSync } = await import('node:sqlite')) } catch { return null }
  const os = await import('node:os')
  const tmp = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pwx-ck-')), 'db')
  try {
    await fs.promises.copyFile(file, tmp)
    const db = new DatabaseSync(tmp, { readOnly: true })
    const row = db.prepare(`select count(*) as n from ${table}`).get()
    db.close()
    return Number(row.n)
  } catch {
    return null
  } finally {
    await fs.promises.rm(path.dirname(tmp), { recursive: true, force: true }).catch(() => {})
  }
}
```

- [ ] **Step 4: Implement the Firefox adapter**

Create `lib/browsers/firefox.js`:

```js
import fs from 'node:fs'
import path from 'node:path'
import { matchFlag, variants, countRows } from './chromium.js'

const USER_JS = [
  'user_pref("browser.sessionstore.resume_from_crash", false);',
  'user_pref("browser.shell.checkDefaultBrowser", false);'
]

export default {
  name: 'firefox',
  cliBrowser: 'firefox',
  lockFiles: ['.parentlock', 'lock', 'parent.lock'],
  pruneDirs: [
    'cache2', 'startupCache', 'shader-cache', 'thumbnails',
    'sessionstore-backups', 'crashes', 'minidumps'
  ],
  installArgs (platform) {
    const a = ['install-browser', 'firefox']
    if (platform === 'linux') a.push('--with-deps')
    return a
  },
  // Firefox has no Preferences JSON. user.js is re-applied at every startup and
  // overrides prefs.js, which is what we want after a profile copy.
  async beforeLaunch (profileDir) {
    await fs.promises.mkdir(profileDir, { recursive: true })
    const file = path.join(profileDir, 'user.js')
    let current = ''
    try { current = await fs.promises.readFile(file, 'utf8') } catch {}
    const missing = USER_JS.filter(line => !current.includes(line))
    if (missing.length) {
      await fs.promises.appendFile(file, (current && !current.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n')
    }
  },
  async cookieCount (profileDir) {
    return countRows(path.join(profileDir, 'cookies.sqlite'), 'moz_cookies')
  },
  argvMatches (cmdline, profileDir, platform = process.platform) {
    const needles = []
    for (const d of variants(profileDir)) { needles.push(`-profile ${d}`, `--profile ${d}`) }
    return matchFlag(cmdline, needles, platform)
  },
  unsafeUrl () { return false }
}
```

Note on `pruneDirs`: the spec also lists `storage/default/*/cache`. Globs are not supported by the copy routine, so Task 6 Step 3 expands any entry containing `*` at copy time. Add `'storage/default/*/cache'` to the list above only after that expansion exists; leave it out for now and add it in Task 6.

- [ ] **Step 5: Implement the registry**

Create `lib/browsers/index.js`:

```js
import chromium from './chromium.js'
import firefox from './firefox.js'

const ADAPTERS = { chromium, firefox }
export const names = Object.keys(ADAPTERS)

export function get (name) {
  const a = ADAPTERS[name]
  if (!a) throw new Error(`pw: unsupported browser '${name}'. Use one of: ${names.join(', ')}`)
  return a
}
```

- [ ] **Step 6: Run the test**

Run: `node --test test/unit/browsers.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 7: Commit**

```bash
git add lib/browsers test/unit/browsers.test.js
git commit -m "feat(pwx): add chromium and firefox adapters behind one interface"
```

---

### Task 5: lib/engine.js — spawn playwright-cli and read its state

**Files:**
- Create: `lib/engine.js`
- Test: `test/unit/engine.test.js`

**Interfaces:**
- Consumes: `lib/config.js` Ctx.
- Produces:
  - `resolveEngine(ctx) -> {cmd, prefixArgs}`
  - `run(ctx, args, {capture=false, env={}}) -> Promise<{code, stdout, stderr}>`
  - `parseList(text, session) -> {present:boolean, open:boolean, headed:boolean}`
  - `sessionState(ctx, {retries=1}) -> Promise<'open'|'closed'|'unknown'>`
  - `sessionHeaded(ctx) -> Promise<boolean>`
  - `clearSessionCache(ctx) -> Promise<{removed:number, dirMissing:boolean}>`

- [ ] **Step 1: Confirm the engine entry path**

Run: `npm install && node -e "const p=require('@playwright/cli/package.json');console.log(p.bin)"`
Record the path printed. Use it in Step 3 and correct `.github/workflows/ci.yml` from Task 1 if it differs from `cli.js`.

- [ ] **Step 2: Write the failing test**

Create `test/unit/engine.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseList, sessionState, clearSessionCache, run } from '../../lib/engine.js'

const STUB = path.resolve('test/stub/playwright-cli.js')
const mkctx = over => ({
  bin: STUB, session: 'pw-a', scratchDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-s-')),
  headless: false, daemonDir: '/nonexistent', ...over
})

const LIST = `Browser sessions:
- pw-a: status: open, headed: true, persistent: true
- pw-b: status: closed, headed: false
`

test('parseList finds our row only', () => {
  assert.deepEqual(parseList(LIST, 'pw-a'), { present: true, open: true, headed: true })
  assert.deepEqual(parseList(LIST, 'pw-b'), { present: true, open: false, headed: false })
  assert.deepEqual(parseList(LIST, 'pw-zz'), { present: false, open: false, headed: false })
})

test('parseList does not let a neighbouring row leak into ours', () => {
  const t = `- pw-a: status: closed\n- pw-b: status: open, headed: true\n`
  assert.equal(parseList(t, 'pw-a').open, false)
})

test('run passes the session flag, cwd, and headless env to the engine', async () => {
  const ctx = mkctx()
  const log = path.join(ctx.scratchDir, 'log')
  await run(ctx, ['goto', 'https://x.test'], { env: { PW_STUB_LOG: log } })
  const rec = JSON.parse(fs.readFileSync(log, 'utf8').trim())
  assert.deepEqual(rec.argv, ['-s=pw-a', 'goto', 'https://x.test'])
  assert.equal(rec.env.PLAYWRIGHT_MCP_HEADLESS, 'false')
  assert.equal(fs.realpathSync(rec.cwd), fs.realpathSync(ctx.scratchDir))
})

test('sessionState reports unknown when list fails twice', async () => {
  const ctx = mkctx()
  const state = await sessionState(ctx, { env: { PW_STUB_EXIT: '3' }, sleep: async () => {} })
  assert.equal(state, 'unknown')
})

test('sessionState reports unknown on empty output', async () => {
  const ctx = mkctx()
  assert.equal(await sessionState(ctx, { sleep: async () => {} }), 'unknown')
})

test('sessionState reads open and closed', async () => {
  const ctx = mkctx()
  const listFile = path.join(ctx.scratchDir, 'list')
  fs.writeFileSync(listFile, LIST)
  assert.equal(await sessionState(ctx, { env: { PW_STUB_LIST: listFile } }), 'open')
  assert.equal(await sessionState({ ...ctx, session: 'pw-b' }, { env: { PW_STUB_LIST: listFile } }), 'closed')
})

test('clearSessionCache removes only records whose socket is gone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-d-'))
  const live = path.join(dir, 'sock.live')
  fs.writeFileSync(live, '')
  fs.writeFileSync(path.join(dir, 'pw-a.session'), JSON.stringify({ socketPath: '/gone/x.sock' }))
  const other = path.join(dir, 'sub')
  fs.mkdirSync(other)
  fs.writeFileSync(path.join(other, 'pw-a.session'), JSON.stringify({ socketPath: live }))
  const res = await clearSessionCache({ ...mkctx(), daemonDir: dir })
  assert.equal(res.removed, 1)
  assert.equal(fs.existsSync(path.join(dir, 'pw-a.session')), false)
  assert.equal(fs.existsSync(path.join(other, 'pw-a.session')), true)
})

test('clearSessionCache reports a missing daemon dir instead of silently doing nothing', async () => {
  const res = await clearSessionCache(mkctx({ daemonDir: path.join(os.tmpdir(), 'no-such-daemon-dir') }))
  assert.equal(res.dirMissing, true)
})
```

- [ ] **Step 3: Implement lib/engine.js**

```js
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Always run the CLI's JS entry through this Node binary. On Windows the npm
// bin is a .cmd, and Node refuses to spawn .cmd without a shell; resolving the
// script sidesteps shell quoting entirely and keeps one code path per OS.
export function resolveEngine (ctx) {
  if (ctx.bin) {
    if (ctx.bin.endsWith('.js')) return { cmd: process.execPath, prefixArgs: [ctx.bin] }
    return { cmd: ctx.bin, prefixArgs: [] }
  }
  const pkgPath = require.resolve('@playwright/cli/package.json')
  const pkg = require('@playwright/cli/package.json')
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[Object.keys(pkg.bin)[0]]
  return { cmd: process.execPath, prefixArgs: [path.join(path.dirname(pkgPath), rel)] }
}

export function run (ctx, args, { capture = false, env = {}, session = true } = {}) {
  const { cmd, prefixArgs } = resolveEngine(ctx)
  const full = [...prefixArgs, ...(session ? [`-s=${ctx.session}`] : []), ...args]
  fs.mkdirSync(ctx.scratchDir, { recursive: true })
  return new Promise(resolve => {
    const child = spawn(cmd, full, {
      // playwright-cli picks its daemon by hashing cwd. Every call must run
      // from the same directory or commands cannot see each other's sessions.
      cwd: ctx.scratchDir,
      stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      env: {
        ...process.env,
        PLAYWRIGHT_MCP_HEADLESS: String(ctx.headless),
        PLAYWRIGHT_MCP_OUTPUT_DIR: process.env.PLAYWRIGHT_MCP_OUTPUT_DIR || ctx.scratchDir,
        ...env
      }
    })
    let stdout = ''; let stderr = ''
    child.stdout?.on('data', d => { stdout += d })
    child.stderr?.on('data', d => { stderr += d })
    child.on('error', () => resolve({ code: 127, stdout, stderr }))
    child.on('close', code => resolve({ code: code ?? 0, stdout, stderr }))
  })
}

// Read only our own row. Stopping at the next "- " is what keeps a neighbouring
// session's "status: open" from being read as ours.
export function parseList (text, session) {
  const res = { present: false, open: false, headed: false }
  const head = new RegExp('^\\s*-\\s*' + session.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':')
  let inRow = false
  for (const line of String(text).split('\n')) {
    if (/^\s*-\s/.test(line)) {
      inRow = head.test(line)
      if (!inRow) continue
      res.present = true
    }
    if (!inRow) continue
    if (/status:\s*open/.test(line)) res.open = true
    if (/headed:\s*true/.test(line)) res.headed = true
  }
  return res
}

const wait = ms => new Promise(r => setTimeout(r, ms))

// "unknown" exists because concluding "closed" licenses the caller to KILL
// whatever holds the profile, and a `list` that failed to run is
// indistinguishable from one that found nothing. Empty stdout counts as
// failure: the real CLI prints "(no browsers)" for an empty registry.
export async function sessionState (ctx, { retries = 1, env = {}, sleep = wait } = {}) {
  let out = null
  for (let i = 0; i <= retries; i++) {
    const r = await run(ctx, ['list'], { capture: true, session: false, env })
    if (r.code === 0 && r.stdout.trim()) { out = r.stdout; break }
    if (i < retries) await sleep(300)
  }
  if (out === null) return 'unknown'
  return parseList(out, ctx.session).open ? 'open' : 'closed'
}

export async function sessionHeaded (ctx, opts = {}) {
  const r = await run(ctx, ['list'], { capture: true, session: false, env: opts.env ?? {} })
  if (r.code !== 0) return false
  return parseList(r.stdout, ctx.session).headed
}

// The daemon caches launch options (including headless) in <session>.session and
// reuses them, ignoring the current env. Delete it before a launch so the mode
// takes effect. The daemon dir is shared across workspaces, so a record whose
// socket is still alive belongs to another workspace's live session: removing
// that one orphans their browser.
export async function clearSessionCache (ctx) {
  const root = ctx.daemonDir
  if (!fs.existsSync(root)) return { removed: 0, dirMissing: true }
  let removed = 0
  const target = `${ctx.session}.session`
  const dirs = [root, ...fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => path.join(root, d.name))]
  for (const dir of dirs) {
    const file = path.join(dir, target)
    if (!fs.existsSync(file)) continue
    let sock = ''
    try { sock = JSON.parse(fs.readFileSync(file, 'utf8')).socketPath || '' } catch {}
    if (sock && fs.existsSync(sock)) continue
    try { fs.unlinkSync(file); removed++ } catch {}
  }
  return { removed, dirMissing: false }
}
```

- [ ] **Step 4: Run the test**

Run: `node --test test/unit/engine.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/engine.js test/unit/engine.test.js
git commit -m "feat(pwx): spawn playwright-cli portably and read session state"
```

---

### Task 6: lib/session.js — copy, seed, promote, sweep, reap

**Files:**
- Create: `lib/session.js`
- Test: `test/unit/session.test.js`

**Interfaces:**
- Consumes: `lib/config.js` Ctx, `lib/browsers/index.js` Adapter, `lib/procs.js`.
- Produces:
  - `dirHasContent(dir) -> boolean`
  - `copyProfile(src, dst, adapter) -> Promise<boolean>`
  - `migrateGolden(ctx) -> Promise<boolean>`
  - `profileBrowserPids(adapter, dir, {platform, listProcesses}) -> Promise<number[]>`
  - `killProfileBrowsers(ctx, adapter, deps) -> Promise<number[]>`
  - `seedFromGolden(ctx, adapter) -> Promise<'seeded'|'skipped'|'failed'>`
  - `promote(ctx, adapter) -> Promise<{ok:boolean, error?:string, cookies:number|null}>`
  - `sweepStale(ctx, {listing, now, deps}) -> Promise<number>`
  - `touchLastUsed(ctx) -> void`, `recordBrowser(ctx) -> void`, `setMode(ctx, 'headed'|'headless') -> void`

- [ ] **Step 1: Write the failing test**

Create `test/unit/session.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { get } from '../../lib/browsers/index.js'
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

test('promote swaps golden and restores the old one when the swap fails', async () => {
  const root = mk(); const ctx = ctxFor(root)
  write(path.join(ctx.profileDir, 'Default', 'Cookies'), 'new')
  write(path.join(ctx.goldenDir, 'Default', 'Cookies'), 'old')
  const deps = { listProcesses: async () => [] }
  const res = await promote(ctx, get('chromium'), deps)
  assert.equal(res.ok, true)
  assert.equal(fs.readFileSync(path.join(ctx.goldenDir, 'Default', 'Cookies'), 'utf8'), 'new')
  assert.equal(fs.existsSync(`${ctx.goldenDir}.old`), false)
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
  const removed = await sweepStale(ctx, { listing: '- pw-listed: status: open\n', deps })
  assert.equal(removed, 1)
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'stale')), false)
  for (const k of ['cur', 'live', 'listed', 'fresh']) {
    assert.equal(fs.existsSync(path.join(root, 'sessions', k)), true, k)
  }
})

test('dirHasContent', () => {
  const d = mk()
  assert.equal(dirHasContent(d), false)
  write(path.join(d, 'a'))
  assert.equal(dirHasContent(d), true)
  assert.equal(dirHasContent(path.join(d, 'nope')), false)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/unit/session.test.js`
Expected: FAIL, cannot find module `../../lib/session.js`.

- [ ] **Step 3: Implement lib/session.js**

```js
import fs from 'node:fs'
import path from 'node:path'
import { listProcesses as defaultList, killPids } from './procs.js'
import { get } from './browsers/index.js'

export function dirHasContent (dir) {
  try { return fs.readdirSync(dir).length > 0 } catch { return false }
}

function expandPrune (src, entries) {
  const out = []
  for (const rel of entries) {
    if (!rel.includes('*')) { out.push(rel); continue }
    const [before, after] = rel.split('*')
    const baseDir = path.join(src, before)
    let kids = []
    try { kids = fs.readdirSync(baseDir) } catch { continue }
    for (const k of kids) out.push(path.join(before, k, after).replace(/[\\/]+/g, path.sep))
  }
  return out
}

// Copy a profile minus the caches, then clear the lock files the copy must not
// inherit. Used in both directions: golden -> session and session -> golden.
// The caches are ~95% of a long-lived profile and hold no auth state.
export async function copyProfile (src, dst, adapter) {
  try {
    const skip = new Set(expandPrune(src, adapter.pruneDirs).map(p => path.resolve(src, p)))
    await fs.promises.cp(src, dst, {
      recursive: true,
      force: true,
      errorOnExist: false,
      filter: s => !skip.has(path.resolve(s))
    })
    for (const lock of adapter.lockFiles) {
      await fs.promises.rm(path.join(dst, lock), { force: true, recursive: true }).catch(() => {})
    }
    return true
  } catch {
    return false
  }
}

export async function profileBrowserPids (adapter, dir, { listProcesses = defaultList, platform = process.platform } = {}) {
  if (!fs.existsSync(dir)) return []
  const procs = await listProcesses({ platform })
  return procs.filter(p => adapter.argvMatches(p.cmdline, dir, platform)).map(p => p.pid)
}

export async function killProfileBrowsers (ctx, adapter, deps = {}) {
  if (ctx.ephemeral || !fs.existsSync(ctx.profileDir)) return []
  const pids = await profileBrowserPids(adapter, ctx.profileDir, { ...deps, platform: ctx.platform })
  // On Windows the renderer children do not die with the parent, so every
  // matching process is killed, not just the first.
  await killPids(pids, { platform: ctx.platform })
  for (const lock of adapter.lockFiles) {
    await fs.promises.rm(path.join(ctx.profileDir, lock), { force: true, recursive: true }).catch(() => {})
  }
  return pids
}

// One-time lift of the pre-multi-browser layout: golden/ held a Chromium
// profile directly. Treat it as golden/chromium so a long-standing user's
// logins survive the upgrade.
export async function migrateGolden (ctx) {
  const flat = path.join(ctx.stateRoot, 'golden')
  if (!dirHasContent(flat)) return false
  const entries = fs.readdirSync(flat)
  if (entries.some(e => e === 'chromium' || e === 'firefox')) return false
  const staging = `${flat}.migrating.${process.pid}`
  await fs.promises.rename(flat, staging)
  await fs.promises.mkdir(flat, { recursive: true })
  await fs.promises.rename(staging, path.join(flat, 'chromium'))
  return true
}

export async function seedFromGolden (ctx, adapter, deps = {}) {
  if (!ctx.isolated || !ctx.seed || ctx.ephemeral) return 'skipped'
  if (fs.existsSync(path.join(ctx.stateDir, 'no-seed'))) return 'skipped'
  if (dirHasContent(ctx.profileDir)) return 'skipped'
  await migrateGolden(ctx).catch(() => {})
  if (!dirHasContent(ctx.goldenDir)) return 'skipped'
  const staging = `${ctx.profileDir}.seeding.${process.pid}`
  await fs.promises.mkdir(path.dirname(ctx.profileDir), { recursive: true })
  await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
  // Stage then rename: an interrupted copy must not leave a half profile that
  // the next launch mistakes for an already-seeded one.
  if (!await copyProfile(ctx.goldenDir, staging, adapter)) {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
    return 'failed'
  }
  await fs.promises.rm(ctx.profileDir, { recursive: true, force: true }).catch(() => {})
  try {
    await fs.promises.rename(staging, ctx.profileDir)
    return 'seeded'
  } catch {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
    return 'failed'
  }
}

export async function promote (ctx, adapter, deps = {}) {
  if (ctx.ephemeral) return { ok: false, error: 'PW_EPHEMERAL=1 — there is no on-disk profile to promote.', cookies: null }
  if (!dirHasContent(ctx.profileDir)) {
    return { ok: false, error: `no profile at ${ctx.profileDir} yet — open a browser and log in first.`, cookies: null }
  }
  const pids = await profileBrowserPids(adapter, ctx.profileDir, { ...deps, platform: ctx.platform })
  if (pids.length) {
    return { ok: false, error: "browser still running on this profile. Run 'pwx end' first, then 'pwx promote' (copying a live profile corrupts the cookie store).", cookies: null }
  }
  const staging = `${ctx.goldenDir}.promoting.${process.pid}`
  await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
  await fs.promises.mkdir(path.dirname(ctx.goldenDir), { recursive: true })
  if (!await copyProfile(ctx.profileDir, staging, adapter)) {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
    return { ok: false, error: 'copy failed', cookies: null }
  }
  const old = `${ctx.goldenDir}.old`
  await fs.promises.rm(old, { recursive: true, force: true }).catch(() => {})
  const hadGolden = fs.existsSync(ctx.goldenDir)
  if (hadGolden) await fs.promises.rename(ctx.goldenDir, old)
  try {
    await fs.promises.rename(staging, ctx.goldenDir)
  } catch {
    // Restoring matters more than the promote: the old golden holds the saved
    // logins of every future session.
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
    if (hadGolden) await fs.promises.rename(old, ctx.goldenDir).catch(() => {})
    return { ok: false, error: 'could not install golden profile (previous golden restored)', cookies: null }
  }
  await fs.promises.rm(old, { recursive: true, force: true }).catch(() => {})
  return { ok: true, cookies: await adapter.cookieCount(ctx.goldenDir) }
}

// A session dir goes only when it is not ours, has no live browser, is not open
// in the registry, and has gone unused for the TTL.
export async function sweepStale (ctx, { listing = '', now = Date.now() / 1000, deps = {} } = {}) {
  const root = path.join(ctx.stateRoot, 'sessions')
  let kids = []
  try { kids = fs.readdirSync(root, { withFileTypes: true }) } catch { return 0 }
  let removed = 0
  for (const ent of kids) {
    if (!ent.isDirectory()) continue
    const key = ent.name
    if (key === ctx.sessionKey) continue
    const dir = path.join(root, key)
    if (new RegExp(`^\\s*-\\s*pw-${key}:`, 'm').test(listing)) continue
    const browser = (() => {
      try { return fs.readFileSync(path.join(dir, 'browser'), 'utf8').trim() } catch { return 'chromium' }
    })()
    const adapter = get(browser === 'firefox' ? 'firefox' : 'chromium')
    const pids = await profileBrowserPids(adapter, path.join(dir, 'profile'), { ...deps, platform: ctx.platform })
    if (pids.length) continue
    let stamp = Number((() => { try { return fs.readFileSync(path.join(dir, 'last-used'), 'utf8').trim() } catch { return '' } })())
    if (!Number.isFinite(stamp) || !stamp) {
      try { stamp = fs.statSync(dir).mtimeMs / 1000 } catch { stamp = now }
    }
    if ((now - stamp) / 86400 < ctx.ttlDays) continue
    try { fs.rmSync(dir, { recursive: true, force: true }); removed++ } catch {}
  }
  // Interrupted seeds leave a staging dir behind; drop the ones whose pid is gone.
  try {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      for (const f of fs.readdirSync(path.join(root, ent.name))) {
        const m = /^profile\.seeding\.(\d+)$/.exec(f)
        if (m && !isAliveSafe(Number(m[1]))) {
          fs.rmSync(path.join(root, ent.name, f), { recursive: true, force: true })
        }
      }
    }
  } catch {}
  return removed
}

function isAliveSafe (pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

export function touchLastUsed (ctx) {
  try {
    fs.mkdirSync(ctx.stateDir, { recursive: true })
    fs.writeFileSync(path.join(ctx.stateDir, 'last-used'), String(Math.floor(Date.now() / 1000)))
  } catch {}
}

export function recordBrowser (ctx) {
  try {
    fs.mkdirSync(ctx.stateDir, { recursive: true })
    fs.writeFileSync(path.join(ctx.stateDir, 'browser'), `${ctx.browser}\n`)
  } catch {}
}

export function setMode (ctx, mode) {
  try {
    fs.mkdirSync(ctx.stateDir, { recursive: true })
    fs.writeFileSync(path.join(ctx.stateDir, 'mode'), `${mode}\n`)
  } catch {}
}
```

- [ ] **Step 4: Add the glob prune entry to the Firefox adapter**

Now that `expandPrune` exists, append `'storage/default/*/cache'` to `pruneDirs` in `lib/browsers/firefox.js`.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS, all suites green.

- [ ] **Step 6: Commit**

```bash
git add lib/session.js lib/browsers/firefox.js test/unit/session.test.js
git commit -m "feat(pwx): seed, promote, sweep, and reap per-session profiles"
```

---

### Task 7: bin/pwx.js — dispatch, open, passthrough

**Files:**
- Create: `bin/pwx.js`
- Test: `test/unit/cli-open.test.js`

**Interfaces:**
- Consumes: all libs.
- Produces: `pwx <verb>` exits 0 on success, 2 on a wrapper error (`die`). Verbs implemented here: `open`, `fresh`, `end`, `help`. Everything not recognised is passed to playwright-cli with `-s=<session>`. `list`, `close-all`, `kill-all`, `install`, `--version`, `-V` pass through without the session flag.

- [ ] **Step 1: Write the failing test**

Create `test/unit/cli-open.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

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

function listFile (root, body) {
  const f = path.join(root, 'list.txt')
  fs.writeFileSync(f, body)
  return f
}

test('open with no live session launches with the persistent profile', async () => {
  const pre = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-pre-'))
  const lf = listFile(pre, '- pw-sess1: status: closed\n')
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
  const lf = listFile(pre, '- pw-sess1: status: closed\n')
  const r = await runCli(['open', '--browser', 'firefox', 'https://example.test'], { PW_STUB_LIST: lf })
  const openCall = r.calls.find(c => c.argv.includes('open'))
  assert.ok(openCall.argv.includes('firefox'))
  assert.equal(fs.readFileSync(path.join(r.root, 'sessions', 'sess1', 'browser'), 'utf8').trim(), 'firefox')
})

test('open on a live session navigates instead of relaunching', async () => {
  const pre = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-pre-'))
  const lf = listFile(pre, '- pw-sess1: status: open, headed: true\n')
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
  const lf = listFile(pre, '- pw-sess1: status: closed\n')
  const first = await runCli(['open', '--browser', 'firefox', 'https://e.test'], { PW_STUB_LIST: lf })
  const r = await new Promise(resolve => {
    execFile(process.execPath, [CLI, 'open', '--browser', 'chromium', 'https://e.test'], {
      env: { ...process.env, PW_BIN: STUB, PW_STATE_ROOT: first.root, PW_SCRATCH_DIR: path.join(first.root, 'scratch'), CLAUDE_CODE_SESSION_ID: 'sess1', PW_STUB_LIST: lf }
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stderr }))
  })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /already running firefox/)
})

test('unknown verbs pass through with the session flag', async () => {
  const r = await runCli(['snapshot'])
  assert.deepEqual(r.calls.at(-1).argv, ['-s=pw-sess1', 'snapshot'])
})

test('list passes through without the session flag', async () => {
  const r = await runCli(['list'])
  assert.deepEqual(r.calls.at(-1).argv, ['list'])
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/unit/cli-open.test.js`
Expected: FAIL, cannot find `bin/pwx.js`.

- [ ] **Step 3: Implement bin/pwx.js with the Task 7 verbs**

```js
#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { resolve as resolveCtx } from '../lib/config.js'
import { get as getAdapter } from '../lib/browsers/index.js'
import * as engine from '../lib/engine.js'
import * as session from '../lib/session.js'

const PASSTHROUGH_NO_SESSION = new Set(['list', 'close-all', 'kill-all', 'install', '--version', '-V'])
const WRAPPER_VERBS = new Set([
  'help', '-h', '--help', 'open', 'fresh', 'end', 'show', 'hide', 'status',
  'gc', 'promote', 'forget', 'logout', 'nuke', 'selftest', 'config', 'menu'
])
const READ_ONLY = new Set(['help', '-h', '--help', 'status', 'gc', 'list', 'selftest', 'config', '--version', '-V'])

export function die (msg) {
  process.stderr.write(`pw: ${msg}\n`)
  process.exit(2)
}
const say = msg => process.stdout.write(`pw: ${msg}\n`)
const warn = msg => process.stderr.write(`pw: ${msg}\n`)

// --browser is ours, not playwright-cli's, so pull it out before anything else
// sees the argv.
export function extractBrowser (argv) {
  const out = []
  let browser = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--browser' && argv[i + 1]) { browser = argv[++i]; continue }
    if (argv[i].startsWith('--browser=')) { browser = argv[i].slice('--browser='.length); continue }
    out.push(argv[i])
  }
  return { argv: out, browser }
}

async function launchArgs (ctx, adapter) {
  if (ctx.ephemeral) return []
  const seeded = await session.seedFromGolden(ctx, adapter)
  if (seeded === 'seeded') warn(`seeded this session's profile from ${ctx.goldenDir} (saved logins carried over).`)
  if (seeded === 'failed') warn(`could not seed from ${ctx.goldenDir} — starting logged out.`)
  fs.mkdirSync(ctx.profileDir, { recursive: true })
  await adapter.beforeLaunch(ctx.profileDir)
  return ['--persistent', '--profile', ctx.profileDir]
}

async function doLaunch (ctx, adapter, urls) {
  const args = await launchArgs(ctx, adapter)
  const cleared = await engine.clearSessionCache(ctx)
  if (cleared.dirMissing) {
    warn(`playwright daemon dir not found at ${ctx.daemonDir}; a headed/headless switch may not take effect.`)
  }
  session.recordBrowser(ctx)
  const r = await engine.run(ctx, ['open', '--browser', adapter.cliBrowser, ...args, ...urls])
  if (r.code !== 0) {
    await session.killProfileBrowsers(ctx, adapter)
    die('open failed — profile browsers killed, lock cleared. Re-run pwx open.')
  }
}

async function main () {
  const raw = process.argv.slice(2).filter(a => a !== '--persistent')
  const { argv, browser: flagBrowser } = extractBrowser(raw)
  const cmd = argv[0] ?? 'help'
  const rest = argv.slice(1)

  let ctx
  try {
    ctx = resolveCtx({ argvBrowser: flagBrowser })
  } catch (e) {
    die(e.message.replace(/^pw: /, ''))
  }
  const adapter = getAdapter(ctx.browser)

  const recorded = (() => {
    try { return fs.readFileSync(path.join(ctx.stateDir, 'browser'), 'utf8').trim() } catch { return '' }
  })()
  if (recorded && recorded !== ctx.browser && ['open', 'fresh'].includes(cmd)) {
    const state = await engine.sessionState(ctx)
    if (state === 'open') {
      die(`session '${ctx.session}' is already running ${recorded}. Run 'pwx end' first to switch to ${ctx.browser}.`)
    }
  }

  if (!READ_ONLY.has(cmd)) session.touchLastUsed(ctx)
  fs.mkdirSync(ctx.scratchDir, { recursive: true })

  switch (cmd) {
    case 'help': case '-h': case '--help':
      printHelp(ctx)
      await engine.run(ctx, ['--help'], { session: false })
      return

    case 'open': {
      for (const a of rest) { if (adapter.unsafeUrl(a)) die(`refusing download URL '${a}' — use the regular page URL instead (see skill docs).`) }
      const state = await engine.sessionState(ctx)
      if (state === 'unknown') {
        die("cannot tell whether your browser is running — 'list' failed twice. Refusing to relaunch, which would kill a live browser and any login it is holding. Retry in a moment, or run 'pwx status'.")
      }
      if (state === 'open') {
        if (!rest.length) { say(`session '${ctx.session}' already open (reusing). 'pwx status' to inspect; 'pwx fresh URL' to force a new browser.`); return }
        const r = await engine.run(ctx, ['goto', ...rest])
        if (r.code !== 0) {
          await session.killProfileBrowsers(ctx, adapter)
          die('goto failed — profile browsers killed, lock cleared. Re-run pwx open.')
        }
        return
      }
      const orphans = await session.profileBrowserPids(adapter, ctx.profileDir, { platform: ctx.platform })
      if (orphans.length) warn(`no live session for '${ctx.session}' — reaping the orphaned browser still holding your profile, then launching a new one.`)
      await session.killProfileBrowsers(ctx, adapter)
      const listing = await engine.run(ctx, ['list'], { capture: true, session: false })
      await session.sweepStale(ctx, { listing: listing.stdout })
      await doLaunch(ctx, adapter, rest)
      return
    }

    case 'fresh':
      await engine.run(ctx, ['close'], { capture: true })
      await session.killProfileBrowsers(ctx, adapter)
      await doLaunch(ctx, adapter, rest)
      return

    case 'end':
      await engine.run(ctx, ['close'], { capture: true })
      await session.killProfileBrowsers(ctx, adapter)
      say(ctx.ephemeral
        ? `session '${ctx.session}' closed.`
        : `session '${ctx.session}' closed (login profile kept: ${ctx.profileDir}).`)
      return

    default: {
      if (WRAPPER_VERBS.has(cmd)) die(`verb '${cmd}' is not implemented yet.`)
      const r = PASSTHROUGH_NO_SESSION.has(cmd)
        ? await engine.run(ctx, argv, { session: false })
        : await engine.run(ctx, argv)
      process.exit(r.code)
    }
  }
}

function printHelp (ctx) {
  const mode = ctx.headless ? 'headless (invisible)' : 'headed (visible)'
  const scope = ctx.isolated ? 'isolated to this agent session' : 'shared (no CLAUDE_CODE_SESSION_ID, or PW_PROFILE_DIR set)'
  process.stdout.write(`pwx — browser wrapper (session '${ctx.session}', ${scope}; ${ctx.browser}; currently ${mode}; artifacts in ${ctx.scratchDir})

  pwx open URL       open (or reuse) this session's browser and navigate
  pwx open --browser firefox URL   same, on Firefox (per session; chromium is the default)
  pwx show           make the browser visible (relaunch headed; logins + page survive)
  pwx hide           make the browser invisible again (relaunch headless)
  pwx status         session name, browser, profile, mode, last used, orphan warnings
  pwx gc             reap this session's orphaned browsers + stale locks + old profiles
  pwx fresh URL      force a NEW browser (close current, relaunch)
  pwx promote        save this session's logins as the golden seed for new sessions
  pwx forget         clear the saved login (--golden also clears the seed)
  pwx end            close the session (saved login persists on disk)
  pwx nuke           reset THIS session (--all resets every session)
  pwx config         show or set machine defaults (browser, headed)
  pwx menu           interactive picker
  pwx selftest       verify session mode + no repo litter

Profile: ${ctx.profileDir}
Golden:  ${ctx.goldenDir}
All other commands pass through to playwright-cli, scoped to '${ctx.session}'.
playwright-cli's own help follows:
`)
}

main().catch(e => die(e.stack || String(e)))
```

- [ ] **Step 4: Make it executable and run the tests**

```bash
chmod +x bin/pwx.js
node --test test/unit/cli-open.test.js
```
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add bin/pwx.js test/unit/cli-open.test.js
git commit -m "feat(pwx): dispatch, open, fresh, end, and passthrough"
```

---

### Task 8: Remaining verbs — status, show, hide, gc, promote, forget, nuke, selftest

**Files:**
- Modify: `bin/pwx.js` (replace the `default:` guard for the listed verbs)
- Test: `test/unit/cli-verbs.test.js`

**Interfaces:**
- Consumes: Task 7's `runCli` harness shape (re-declared in this test file).
- Produces: all wrapper verbs implemented; `WRAPPER_VERBS` no longer reaches the "not implemented yet" branch except for `config` and `menu` (Task 9).

- [ ] **Step 1: Write the failing test**

Create `test/unit/cli-verbs.test.js`. Reuse the same `runCli` helper as Task 7 (copy it in; the two files run independently).

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

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
const listFile = (root, body) => { const f = path.join(root, 'l.txt'); fs.writeFileSync(f, body); return f }

test('hide writes the mode file and future opens are headless', async () => {
  const root = mkroot()
  await runIn(root, ['hide'], { PW_STUB_LIST: listFile(root, '- pw-sess1: status: closed\n') })
  assert.equal(fs.readFileSync(path.join(root, 'sessions', 'sess1', 'mode'), 'utf8').trim(), 'headless')
  const r = await runIn(root, ['open', 'https://e.test'], { PW_STUB_LIST: listFile(root, '- pw-sess1: status: closed\n') })
  const openCall = r.calls.find(c => c.argv.includes('open'))
  assert.equal(openCall.env.PLAYWRIGHT_MCP_HEADLESS, 'true')
})

test('show on a live headless session relaunches headed and restores the URL', async () => {
  const root = mkroot()
  const lf = listFile(root, '- pw-sess1: status: open, headed: false\n')
  const r = await runIn(root, ['show'], { PW_STUB_LIST: lf })
  assert.ok(r.calls.some(c => c.argv.includes('eval')), 'should capture the current URL')
  assert.ok(r.calls.some(c => c.argv.includes('close')))
  const openCall = r.calls.find(c => c.argv.includes('open'))
  assert.equal(openCall.env.PLAYWRIGHT_MCP_HEADLESS, 'false')
})

test('status prints session, browser, profile, and mode', async () => {
  const root = mkroot()
  const r = await runIn(root, ['status'], { PW_STUB_LIST: listFile(root, '- pw-sess1: status: closed\n') })
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
  const r = await runIn(root, ['promote'], { PW_STUB_LIST: listFile(root, '- pw-sess1: status: closed\n') })
  assert.equal(r.code, 0)
  assert.equal(fs.existsSync(path.join(root, 'golden', 'chromium', 'Default', 'Cookies')), true)
  assert.match(r.stdout, /promoted/)
})

test('forget deletes the profile and blocks re-seeding', async () => {
  const root = mkroot()
  write(path.join(root, 'sessions', 'sess1', 'profile', 'x'))
  write(path.join(root, 'golden', 'chromium', 'g'))
  const r = await runIn(root, ['forget'], { PW_STUB_LIST: listFile(root, '- pw-sess1: status: closed\n') })
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'sess1', 'profile')), false)
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'sess1', 'no-seed')), true)
  assert.match(r.stdout, /golden profile still holds logins/)
})

test('forget --golden clears the seed too', async () => {
  const root = mkroot()
  write(path.join(root, 'sessions', 'sess1', 'profile', 'x'))
  write(path.join(root, 'golden', 'chromium', 'g'))
  await runIn(root, ['forget', '--golden'], { PW_STUB_LIST: listFile(root, '- pw-sess1: status: closed\n') })
  assert.equal(fs.existsSync(path.join(root, 'golden', 'chromium')), false)
})

test('nuke is scoped by default and machine-wide with --all', async () => {
  const root = mkroot()
  const lf = listFile(root, '- pw-sess1: status: closed\n')
  const scoped = await runIn(root, ['nuke'], { PW_STUB_LIST: lf })
  assert.ok(!scoped.calls.some(c => c.argv.includes('kill-all')))
  assert.match(scoped.stdout, /other sessions and .* left alone/)
  const all = await runIn(root, ['nuke', '--all'], { PW_STUB_LIST: lf })
  assert.ok(all.calls.some(c => c.argv.includes('kill-all')))
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/unit/cli-verbs.test.js`
Expected: FAIL, verbs report "not implemented yet".

- [ ] **Step 3: Implement the verbs in bin/pwx.js**

Add these cases to the `switch` before `default:`. Add the import `import { killPids } from '../lib/procs.js'` only if needed; the helpers below use `session.*`.

```js
    case 'show': case 'hide': {
      const wantHeadless = cmd === 'hide'
      session.setMode(ctx, wantHeadless ? 'headless' : 'headed')
      const state = await engine.sessionState(ctx)
      if (state !== 'open') {
        say(wantHeadless
          ? 'no session open; headless mode saved — future opens will be invisible.'
          : "no session open; headed mode saved — the next 'pwx open URL' will be visible.")
        return
      }
      const isHeaded = await engine.sessionHeaded(ctx)
      if (isHeaded === !wantHeadless) {
        say(wantHeadless ? 'browser is already headless.' : 'browser is already visible (headed).')
        return
      }
      say(`relaunching ${wantHeadless ? 'headless' : 'headed'} on the same profile (logins and page survive)…`)
      const got = await engine.run(ctx, ['--raw', 'eval', 'location.href'], { capture: true })
      let url = got.stdout.split('\n')[0].trim().replace(/^"|"$/g, '')
      if (!/^https?:\/\//.test(url)) url = ''
      await engine.run(ctx, ['close'], { capture: true })
      await session.killProfileBrowsers(ctx, adapter)
      // The mode file was just written, so re-resolve to pick up the new mode.
      const next = resolveCtx({ argvBrowser: flagBrowser })
      await doLaunch(next, adapter, url ? [url] : [])
      return
    }

    case 'status': {
      const listing = await engine.run(ctx, ['list'], { capture: true, session: false })
      process.stdout.write(listing.stdout)
      say(ctx.isolated
        ? `this session: '${ctx.session}' (isolated; other rows above belong to other sessions)`
        : `this session: '${ctx.session}' (SHARED profile — other sessions can drive this browser)`)
      say(`browser: ${ctx.browser} (from ${ctx.browserSource})`)
      say(`profile: ${ctx.profileDir}`)
      say(`golden:  ${ctx.goldenDir}`)
      say(`daemon:  ${ctx.daemonDir}${fs.existsSync(ctx.daemonDir) ? '' : ' (missing)'}`)
      const state = await engine.sessionState(ctx)
      say(state === 'open' ? 'state: open' : `state: ${state === 'unknown' ? 'unknown' : "not open ('pwx open URL' to launch)"}`)
      say(`default mode: ${ctx.headless ? 'headless' : 'headed'} ('pwx show' / 'pwx hide' to switch)`)
      try {
        const stamp = Number(fs.readFileSync(path.join(ctx.stateDir, 'last-used'), 'utf8').trim())
        if (Number.isFinite(stamp) && stamp) say(`last used: ${new Date(stamp * 1000).toString()}`)
      } catch {}
      if (state !== 'open') {
        const orphans = await session.profileBrowserPids(adapter, ctx.profileDir, { platform: ctx.platform })
        if (orphans.length) {
          warn(`WARNING: orphaned browser process(es) holding the profile: ${orphans.join(' ')}`)
          warn("run 'pwx gc' to clean up ('pwx open URL' also reaps them automatically).")
        }
      }
      return
    }

    case 'gc': {
      const state = await engine.sessionState(ctx)
      if (state === 'open') {
        say(`session '${ctx.session}' is open and tracked — nothing to clean ('pwx end' closes it).`)
      } else if (state === 'unknown') {
        die("cannot tell whether your browser is running — 'list' failed twice. Refusing to reap, which could kill a live browser. Retry in a moment.")
      } else {
        await session.killProfileBrowsers(ctx, adapter)
        say(`cleaned up '${ctx.session}' — orphaned profile browsers reaped, stale locks cleared.`)
      }
      const listing = await engine.run(ctx, ['list'], { capture: true, session: false })
      const n = await session.sweepStale(ctx, { listing: listing.stdout })
      if (n > 0) warn(`reaped ${n} stale session profile(s) (unused > ${ctx.ttlDays}d).`)
      return
    }

    case 'promote': {
      const state = await engine.sessionState(ctx)
      if (state === 'open') die("browser still running on this profile. Run 'pwx end' first, then 'pwx promote'.")
      const res = await session.promote(ctx, adapter)
      if (!res.ok) die(res.error)
      say(`promoted this session's logins to the golden profile (${ctx.goldenDir}).`)
      say("new sessions on this browser will start from it. 'PW_SEED=0' opts out; 'pwx forget --golden' clears it.")
      if (res.cookies === 0) {
        warn('WARNING: the promoted profile has no stored cookies.')
        warn('Browsers flush cookies to disk on a timer; a login closed sooner is lost.')
        warn("leave the browser open ~a minute after logging in, then 'pwx end' and 'pwx promote'.")
      }
      return
    }

    case 'forget': case 'logout': {
      await engine.run(ctx, ['close'], { capture: true })
      await session.killProfileBrowsers(ctx, adapter)
      fs.rmSync(ctx.profileDir, { recursive: true, force: true })
      fs.mkdirSync(ctx.stateDir, { recursive: true })
      // Without this marker the next open silently re-seeds from golden and
      // lands logged back in, the opposite of what forget says.
      fs.writeFileSync(path.join(ctx.stateDir, 'no-seed'), '')
      say(`cleared saved login (${ctx.profileDir}). Next 'pwx open' starts logged-out.`)
      if (rest[0] === '--golden') {
        fs.rmSync(ctx.goldenDir, { recursive: true, force: true })
        say(`also cleared the golden profile (${ctx.goldenDir}) — new sessions start logged-out too.`)
      } else if (session.dirHasContent(ctx.goldenDir)) {
        say("the golden profile still holds logins for NEW sessions ('pwx forget --golden' clears it too).")
      }
      return
    }

    case 'nuke': {
      if (rest[0] === '--all') {
        await engine.run(ctx, ['close-all'], { capture: true, session: false })
        await engine.run(ctx, ['kill-all'], { capture: true, session: false })
        await session.killProfileBrowsers(ctx, adapter)
        fs.rmSync(ctx.scratchDir, { recursive: true, force: true })
        say(`reset ALL sessions (every session's browser killed, scratch wiped: ${ctx.scratchDir}; login profiles kept)`)
      } else {
        await engine.run(ctx, ['close'], { capture: true })
        await session.killProfileBrowsers(ctx, adapter)
        const listing = await engine.run(ctx, ['list'], { capture: true, session: false })
        await session.sweepStale(ctx, { listing: listing.stdout })
        say(`reset '${ctx.session}' (its browser killed; login profile kept: ${ctx.profileDir} — 'pwx forget' to clear it)`)
        say(`other sessions and ${ctx.scratchDir} left alone ('pwx nuke --all' for the machine-wide reset)`)
      }
      return
    }

    case 'selftest': {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-selftest-'))
      const env = {
        ...process.env,
        PW_SESSION: 'pwx-selftest',
        PW_PROFILE_DIR: path.join(tmp, 'profile'),
        PW_SCRATCH_DIR: path.join(tmp, 'scratch'),
        PW_BROWSER: ctx.browser
      }
      const { execFileSync } = await import('node:child_process')
      let rc = 0
      try {
        execFileSync(process.execPath, [process.argv[1], 'open', 'about:blank'], { env, stdio: 'ignore' })
        const out = execFileSync(process.execPath, [process.argv[1], 'list'], { env, encoding: 'utf8' })
        const row = engine.parseList(out, 'pwx-selftest')
        if (row.headed === ctx.headless) { process.stderr.write(`FAIL: session mode mismatch (want headed=${!ctx.headless})\n`); rc = 1 }
      } catch (e) {
        process.stderr.write(`FAIL: ${e.message}\n`); rc = 1
      } finally {
        try { execFileSync(process.execPath, [process.argv[1], 'end'], { env, stdio: 'ignore' }) } catch {}
        fs.rmSync(tmp, { recursive: true, force: true })
      }
      if (rc === 0) {
        process.stdout.write(`PASS: ${ctx.headless ? 'headless' : 'headed'}, single session, ${ctx.browser}, artifacts -> ${ctx.scratchDir}\n`)
      }
      process.exit(rc)
    }
```

Add `import os from 'node:os'` to the imports at the top of `bin/pwx.js`.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add bin/pwx.js test/unit/cli-verbs.test.js
git commit -m "feat(pwx): status, show, hide, gc, promote, forget, nuke, selftest"
```

---

### Task 9: config command and interactive menu

**Files:**
- Create: `lib/menu.js`
- Modify: `bin/pwx.js`
- Test: `test/unit/cli-config-menu.test.js`

**Interfaces:**
- Consumes: `lib/config.js`.
- Produces: `runMenu(ctx, {input, output}) -> Promise<string[]>` returns the argv the user picked, or `[]` on quit. `pwx config` prints a table of `key`, `value`, `source`. `pwx config set <key> <value>` writes `config.json`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/cli-config-menu.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { runMenu } from '../../lib/menu.js'
import { Readable, Writable } from 'node:stream'

const CLI = path.resolve('bin/pwx.js')
const STUB = path.resolve('test/stub/playwright-cli.js')
const mkroot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-cm-'))

function runIn (root, args) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, PW_BIN: STUB, PW_STATE_ROOT: root, PW_SCRATCH_DIR: path.join(root, 's'), CLAUDE_CODE_SESSION_ID: 'sess1' }
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }))
  })
}

function fakeIO (lines) {
  const input = Readable.from(lines.map(l => l + '\n'))
  let out = ''
  const output = new Writable({ write (c, e, cb) { out += c; cb() } })
  return { input, output, read: () => out }
}

test('config prints value and source', async () => {
  const root = mkroot()
  const r = await runIn(root, ['config'])
  assert.match(r.stdout, /browser\s+chromium\s+default/)
})

test('config set writes config.json and takes effect', async () => {
  const root = mkroot()
  await runIn(root, ['config', 'set', 'browser', 'firefox'])
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).browser, 'firefox')
  const r = await runIn(root, ['config'])
  assert.match(r.stdout, /browser\s+firefox\s+config/)
})

test('config set rejects an unknown key and an invalid browser', async () => {
  const root = mkroot()
  assert.equal((await runIn(root, ['config', 'set', 'colour', 'blue'])).code, 2)
  assert.equal((await runIn(root, ['config', 'set', 'browser', 'webkit'])).code, 2)
})

test('menu maps a numbered choice plus a URL prompt to argv', async () => {
  const io = fakeIO(['1', 'https://example.test'])
  const argv = await runMenu({ browser: 'chromium', session: 'pw-x' }, io)
  assert.deepEqual(argv, ['open', 'https://example.test'])
  assert.match(io.read(), /1\) open/)
})

test('menu quits on q and re-prompts on a bad choice', async () => {
  assert.deepEqual(await runMenu({ browser: 'chromium', session: 'pw-x' }, fakeIO(['q'])), [])
  const io = fakeIO(['99', 'q'])
  assert.deepEqual(await runMenu({ browser: 'chromium', session: 'pw-x' }, io), [])
  assert.match(io.read(), /not a choice/)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/unit/cli-config-menu.test.js`
Expected: FAIL, cannot find `../../lib/menu.js`.

- [ ] **Step 3: Implement lib/menu.js**

```js
import readline from 'node:readline'

// Kept in sync with the verb list in bin/pwx.js printHelp. Each entry names the
// argv it produces and any extra input to ask for.
export const ITEMS = [
  { label: 'open a URL', argv: ['open'], prompt: 'URL' },
  { label: 'open a URL in Firefox', argv: ['open', '--browser', 'firefox'], prompt: 'URL' },
  { label: 'show (make the browser visible)', argv: ['show'] },
  { label: 'hide (background, headless)', argv: ['hide'] },
  { label: 'status', argv: ['status'] },
  { label: 'snapshot the current page', argv: ['snapshot'] },
  { label: 'screenshot', argv: ['screenshot'] },
  { label: 'gc (reap orphans and stale profiles)', argv: ['gc'] },
  { label: 'promote (save logins for future sessions)', argv: ['promote'] },
  { label: 'end (close the browser, keep logins)', argv: ['end'] },
  { label: 'forget (clear this session login)', argv: ['forget'] },
  { label: 'config', argv: ['config'] }
]

export async function runMenu (ctx, { input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, output })
  const ask = q => new Promise(res => rl.question(q, res))
  try {
    for (;;) {
      output.write(`\npwx — session ${ctx.session}, browser ${ctx.browser}\n`)
      ITEMS.forEach((it, i) => output.write(`  ${i + 1}) ${it.label}\n`))
      output.write('  q) quit\n')
      const pick = (await ask('choice: ')).trim()
      if (pick === 'q' || pick === '') return []
      const idx = Number(pick) - 1
      if (!Number.isInteger(idx) || idx < 0 || idx >= ITEMS.length) {
        output.write(`  '${pick}' is not a choice\n`)
        continue
      }
      const item = ITEMS[idx]
      const argv = [...item.argv]
      if (item.prompt) {
        const val = (await ask(`${item.prompt}: `)).trim()
        if (val) argv.push(val)
      }
      return argv
    }
  } finally {
    rl.close()
  }
}
```

- [ ] **Step 4: Wire config and menu into bin/pwx.js**

Add to the imports: `import { runMenu } from '../lib/menu.js'` and `import { configPath, BROWSERS } from '../lib/config.js'`.

Change the default command from `'help'` to `'menu'` when `process.argv.length === 2` and `process.stdin.isTTY` is true; otherwise keep `'help'`. Add these cases:

```js
    case 'config': {
      if (rest[0] === 'set') {
        const [, key, value] = rest
        if (!['browser', 'headed', 'stateDir'].includes(key)) die(`unknown config key '${key}'. Keys: browser, headed, stateDir`)
        if (key === 'browser' && !BROWSERS.includes(value)) die(`unsupported browser '${value}'. Use one of: ${BROWSERS.join(', ')}`)
        const file = configPath(ctx.stateRoot)
        let cfg = {}
        try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
        cfg[key] = key === 'headed' ? value === 'true' : value
        fs.mkdirSync(ctx.stateRoot, { recursive: true })
        fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
        say(`set ${key} = ${cfg[key]} in ${file}`)
        return
      }
      const rows = [
        ['browser', ctx.browser, ctx.browserSource],
        ['headed', String(!ctx.headless), ctx.headless === undefined ? 'default' : 'resolved'],
        ['stateRoot', ctx.stateRoot, process.env.PW_STATE_ROOT ? 'env' : (ctx.config.stateDir ? 'config' : 'default')],
        ['scratchDir', ctx.scratchDir, process.env.PW_SCRATCH_DIR ? 'env' : 'default'],
        ['daemonDir', ctx.daemonDir, 'derived']
      ]
      for (const [k, v, s] of rows) process.stdout.write(`${k.padEnd(12)} ${String(v).padEnd(40)} ${s}\n`)
      say(`config file: ${configPath(ctx.stateRoot)}`)
      return
    }

    case 'menu': {
      const picked = await runMenu(ctx)
      if (!picked.length) return
      const { execFileSync } = await import('node:child_process')
      try {
        execFileSync(process.execPath, [process.argv[1], ...picked], { stdio: 'inherit' })
      } catch (e) {
        process.exit(e.status ?? 1)
      }
      return
    }
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 6: Commit**

```bash
git add lib/menu.js bin/pwx.js test/unit/cli-config-menu.test.js
git commit -m "feat(pwx): config command and interactive menu"
```

---

### Task 10: Integration tests against real browsers

**Files:**
- Create: `test/integration/helpers.js`, `test/integration/roundtrip.test.js`
- Test: itself

**Interfaces:**
- Consumes: the installed `pwx` from the repo, real `@playwright/cli` browsers.
- Produces: `startServer() -> Promise<{url, close}>` serving `/set` (sets cookie `pwx=1`, prints `set`) and `/read` (prints the received cookie header).

- [ ] **Step 1: Write the helper**

Create `test/integration/helpers.js`:

```js
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

export const SKIP = process.env.PWX_INTEGRATION !== '1'

export function startServer () {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/set')) {
      res.setHeader('Set-Cookie', 'pwx=1; Path=/; Max-Age=86400')
      res.end('<html><body id="r">set</body></html>')
    } else {
      res.end(`<html><body id="r">${req.headers.cookie ?? 'none'}</body></html>`)
    }
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() })
    })
  })
}

export function pwx (args, { root, sessionId, browser }) {
  return new Promise(resolve => {
    execFile(process.execPath, [path.resolve('bin/pwx.js'), ...args], {
      env: {
        ...process.env,
        PW_STATE_ROOT: root,
        PW_SCRATCH_DIR: path.join(root, 'scratch'),
        CLAUDE_CODE_SESSION_ID: sessionId,
        PW_BROWSER: browser,
        PLAYWRIGHT_MCP_HEADLESS: 'true'
      },
      timeout: 120000
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }))
  })
}

export const mkroot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-i-'))
```

- [ ] **Step 2: Write the integration tests**

Create `test/integration/roundtrip.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SKIP, startServer, pwx, mkroot } from './helpers.js'

for (const browser of ['chromium', 'firefox']) {
  test(`${browser}: promote carries a cookie into a new session`, { skip: SKIP }, async () => {
    const srv = await startServer()
    const root = mkroot()
    try {
      await pwx(['open', `${srv.url}/set`], { root, sessionId: 'aaa', browser })
      await pwx(['end'], { root, sessionId: 'aaa', browser })
      const p = await pwx(['promote'], { root, sessionId: 'aaa', browser })
      assert.equal(p.code, 0, p.stderr)
      assert.equal(fs.existsSync(path.join(root, 'golden', browser)), true)

      await pwx(['open', `${srv.url}/read`], { root, sessionId: 'bbb', browser })
      const r = await pwx(['--raw', 'eval', 'document.getElementById("r").textContent'],
        { root, sessionId: 'bbb', browser })
      assert.match(r.stdout, /pwx=1/)
    } finally {
      await pwx(['end'], { root, sessionId: 'bbb', browser })
      srv.close()
    }
  })

  test(`${browser}: two sessions do not share cookies`, { skip: SKIP }, async () => {
    const srv = await startServer()
    const root = mkroot()
    try {
      await pwx(['open', `${srv.url}/set`], { root, sessionId: 'one', browser })
      await pwx(['open', `${srv.url}/read`], { root, sessionId: 'two', browser })
      const r = await pwx(['--raw', 'eval', 'document.getElementById("r").textContent'],
        { root, sessionId: 'two', browser })
      assert.doesNotMatch(r.stdout, /pwx=1/)
    } finally {
      await pwx(['end'], { root, sessionId: 'one', browser })
      await pwx(['end'], { root, sessionId: 'two', browser })
      srv.close()
    }
  })

  test(`${browser}: open reaps an orphan holding the profile`, { skip: SKIP }, async () => {
    const srv = await startServer()
    const root = mkroot()
    try {
      await pwx(['open', `${srv.url}/set`], { root, sessionId: 'orp', browser })
      // Kill the daemon but leave the browser: the exact state that used to
      // fail the next launch with "Browser is already in use".
      await pwx(['kill-all'], { root, sessionId: 'orp', browser })
      const r = await pwx(['open', `${srv.url}/read`], { root, sessionId: 'orp', browser })
      assert.equal(r.code, 0, r.stderr)
    } finally {
      await pwx(['end'], { root, sessionId: 'orp', browser })
      srv.close()
    }
  })

  test(`${browser}: hide then open runs headless`, { skip: SKIP }, async () => {
    const srv = await startServer()
    const root = mkroot()
    try {
      await pwx(['hide'], { root, sessionId: 'mod', browser })
      await pwx(['open', `${srv.url}/read`], { root, sessionId: 'mod', browser })
      const r = await pwx(['list'], { root, sessionId: 'mod', browser })
      assert.match(r.stdout, /pw-mod/)
      assert.doesNotMatch(r.stdout, /headed:\s*true/)
    } finally {
      await pwx(['end'], { root, sessionId: 'mod', browser })
      srv.close()
    }
  })
}
```

- [ ] **Step 3: Install browsers and run locally**

```bash
node node_modules/@playwright/cli/cli.js install-browser chromium
node node_modules/@playwright/cli/cli.js install-browser firefox
PWX_INTEGRATION=1 npm run test:integration
```
Expected: PASS, 8 tests. If a Firefox case fails on profile locking, fix the Firefox adapter's `lockFiles` rather than weakening the test.

- [ ] **Step 4: Commit**

```bash
git add test/integration
git commit -m "test(pwx): integration round-trip for chromium and firefox"
```

- [ ] **Step 5: Push and confirm CI is green on all three OSes**

```bash
git push -u origin HEAD
gh run watch
```
Expected: unit and integration jobs pass on ubuntu-latest, windows-latest, macos-latest. Fix failures before the next task. Do not proceed with red CI.

---

### Task 11: Documentation

**Files:**
- Create: `docs/manual-verification.md`
- Modify: `SKILL.md`, `README.md`

**Interfaces:**
- Consumes: the finished CLI.
- Produces: agent-facing docs that describe `pwx`, the browser flag, and the three OSes.

- [ ] **Step 1: Write the manual verification checklist**

Create `docs/manual-verification.md` with a table to fill in per machine, covering: install from a git clone; `pwx open` headed on chromium; log into a site; `pwx end`; `pwx promote`; second session inherits the login; `pwx open --browser firefox` headed; log in; promote; `pwx status`; `pwx gc`; `pwx selftest`; `pwx menu`. Include the exact commands and a Result column with OS, date, and pass or fail.

- [ ] **Step 2: Update SKILL.md**

Add a browser section documenting `--browser firefox` and the one-browser-per-session rule, note that golden profiles are per browser and per machine, and keep every existing rule about not calling playwright-cli directly and not passing `-s=`. Leave the `pw` command name in place: SKILL.md continues to describe the shipped tool until cutover, and gets its name change in the cutover commit.

- [ ] **Step 3: Update README.md**

Document: requirements (Node 20+), install from clone on macOS, Ubuntu, and Windows, the `pwx` versus `pw` split during development, the state root, and how to run unit and integration tests.

- [ ] **Step 4: Run the full suite one more time**

Run: `npm test && PWX_INTEGRATION=1 npm run test:integration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/manual-verification.md SKILL.md README.md
git commit -m "docs(pwx): manual verification checklist, Firefox and multi-OS notes"
```

---

## Self-Review

**Spec coverage:**

| Spec item | Task |
|---|---|
| Repo layout, no build step, no extra deps | 1 |
| Command surface unchanged, passthrough | 7 |
| `--browser` flag, env, config default, recorded per session | 2, 7, 9 |
| `pwx config`, `pwx menu`, bare `pwx` opens the menu | 9 |
| State root precedence and layout | 2 |
| Golden migration from the flat layout | 6 |
| Scratch dir fixed per tool | 2 |
| Per-OS daemon dir, report when missing | 2, 5, 8 |
| fs.stat timestamps, atomic rename | 6 |
| Adapter interface, both browsers | 4 |
| No python3, `node:sqlite` with a fallback | 4 |
| Process listing per OS, no WMIC | 3 |
| SIGTERM then SIGKILL, Windows kills all matches | 3, 6 |
| Orphan definition and reap points | 6, 7, 8 |
| Live-profile guards on promote and sweep | 6 |
| Seed race staging and cleanup | 6 |
| Unit tests with a stub | 1-9 |
| Integration tests gated on an env var | 10 |
| CI matrix on three OSes | 1, 10 |
| Manual checklist | 11 |
| Cutover | out of scope, spec section "Cutover" |

**Known gaps carried deliberately:** the `patch-screencapture` macOS tool is not ported; it stays a separate bash script and is out of scope for `pwx` until cutover. `test/run.sh` and `bin/pw` are untouched, so the bash suite keeps passing unchanged during development.
