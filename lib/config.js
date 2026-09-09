import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const BROWSERS = ['chromium', 'chrome', 'msedge', 'firefox']
export const SOURCES = ['flag', 'env', 'session', 'config', 'default']

export function sessionKey (env) {
  return String(env.CLAUDE_CODE_SESSION_ID ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)
}

// Mirrors playwright-core/lib/tools/cli-client/registry.js so we look in the
// same place the daemon writes. A wrong path here is silent: the cached
// headless flag is never cleared and `pw show` stops working.
export function daemonDir (env, platform, homedir) {
  let base
  if (platform === 'win32') base = env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local')
  else if (platform === 'darwin') base = path.join(homedir, 'Library', 'Caches')
  else base = env.XDG_CACHE_HOME || path.join(homedir, '.cache')
  if (env.PWTEST_DAEMON_SESSION_DIR) return env.PWTEST_DAEMON_SESSION_DIR
  return path.join(base, 'ms-playwright', 'daemon')
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

// A non-numeric PW_SESSION_TTL_DAYS used to produce NaN. Every age comparison
// against NaN is false, so sweepStale then deleted EVERY idle unlisted session
// profile on the machine regardless of age, destroying other sessions'
// unpromoted logins. One mistyped environment variable was enough. Empty
// counts as unset for the same reason: Number('') is 0, a zero-day TTL, which
// sweeps just as indiscriminately.
const DEFAULT_TTL_DAYS = 7

export function ttlDays (raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_TTL_DAYS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_DAYS
}

export function resolve ({ env = process.env, platform = process.platform, homedir = os.homedir(), argvBrowser = null, tmpdir = os.tmpdir() } = {}) {
  // PW_STATE_ROOT only. PW_CACHE_DIR is deliberately NOT an alias: it is the
  // documented state-root override for the live bash tool (bin/pw). Honouring
  // it here pointed pwx at the bash tool's state directory, where the first
  // isolated open ran the golden migration and broke that tool's seeding, and
  // then both tools shared one session profile so pwx's reaper killed the bash
  // tool's live browser.
  const cfgRootGuess = env.PW_STATE_ROOT || path.join(homedir, '.cache', 'pwx')
  const fileCfg = loadConfigFile(cfgRootGuess)
  const stateRoot = env.PW_STATE_ROOT || fileCfg.stateDir || path.join(homedir, '.cache', 'pwx')
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
    ttlDays: ttlDays(env.PW_SESSION_TTL_DAYS),
    daemonDir: daemonDir(env, platform, homedir),
    config: cfg,
    platform
  }
}
