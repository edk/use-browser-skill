import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirPrivate } from './fsutil.js'

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
  // A fixed, predictable scratch directory under the system temp dir — e.g.
  // /tmp/pwx on Linux — sits inside a world-readable, world-writable
  // location on a shared machine. It receives command output, including
  // screenshots and page snapshots of logged-in pages, so it is created
  // owner-only rather than at the platform default.
  mkdirPrivate(ctx.scratchDir, ctx.platform)
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

// playwright-cli renders `list` as an indented, multi-line human format whose
// continuation lines ("  - status: open") are indistinguishable from row
// headers to a line-oriented parser. Reading it that way made a live session
// report as closed, which sent `open` into reaping and relaunching the very
// browser it was supposed to reuse. The CLI has a global `--json` flag that
// emits {"browsers":[{name, status, headed, ...}]}; that shape is the only one
// parsed here. Never parse the rendered form.
//
// Returns the rows, or null for "could not tell": a call that failed, or
// output that is absent, not JSON, or not the documented shape. null must
// never collapse into an empty array, because callers read "no rows" as
// "nothing is running", which licenses them to kill whatever holds the
// profile.
export function parseBrowsers (text) {
  let data
  try { data = JSON.parse(text) } catch { return null }
  if (!data || typeof data !== 'object' || !Array.isArray(data.browsers)) return null
  // A genuinely empty browsers array is the real "no sessions" answer, and
  // must stay [] so callers can read it as closed.
  if (data.browsers.length === 0) return []
  const rows = data.browsers.filter(row => row && typeof row.name === 'string')
  // A non-empty browsers array that yields no usable row means every row was
  // shaped in a way this parser doesn't recognise — an upstream field rename
  // dropping or renaming `name`, for instance — not that the registry is
  // actually empty. Collapsing that into [] would read as "closed", which
  // licenses a caller to kill whatever holds the profile. Treat it the same
  // as unparseable output: could-not-tell, not empty.
  return rows.length === 0 ? null : rows
}

export function sessionRow (rows, session) {
  if (!Array.isArray(rows)) return null
  return rows.find(row => row.name === session) ?? null
}

const wait = ms => new Promise(r => setTimeout(r, ms))

// "unknown" exists because concluding "closed" licenses the caller to KILL
// whatever holds the profile, and a `list` that failed to run is
// indistinguishable from one that found nothing. Unreadable output counts as
// failure, not as an empty registry: the real CLI answers an empty registry
// with a well-formed {"browsers": []}.
export async function listSessions (ctx, { retries = 1, env = {}, sleep = wait } = {}) {
  for (let i = 0; i <= retries; i++) {
    const r = await run(ctx, ['list', '--json'], { capture: true, session: false, env })
    if (r.code === 0) {
      const rows = parseBrowsers(r.stdout)
      if (rows !== null) return rows
    }
    if (i < retries) await sleep(300)
  }
  return null
}

export async function sessionState (ctx, opts = {}) {
  const rows = await listSessions(ctx, opts)
  if (rows === null) return 'unknown'
  return sessionRow(rows, ctx.session)?.status === 'open' ? 'open' : 'closed'
}

// No retry: this is only ever asked after sessionState already said "open",
// and its one caller treats a false as "not headed", never as "kill it".
export async function sessionHeaded (ctx, opts = {}) {
  const rows = await listSessions(ctx, { env: opts.env ?? {}, retries: 0, sleep: opts.sleep })
  return sessionRow(rows, ctx.session)?.headed === true
}

// The daemon caches launch options (including headless) in <session>.session and
// reuses them, ignoring the current env. Delete it before a launch so the mode
// takes effect. The daemon dir is shared across workspaces, so a record whose
// socket is still alive belongs to another workspace's live session: removing
// that one orphans their browser. A record we cannot read or parse has UNKNOWN
// socket status, not confirmed-gone status, so it must be skipped, not deleted.
export async function clearSessionCache (ctx) {
  const root = ctx.daemonDir
  if (!fs.existsSync(root)) return { removed: 0, skipped: 0, dirMissing: true }
  let removed = 0
  let skipped = 0
  const target = `${ctx.session}.session`
  const dirs = [root, ...fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => path.join(root, d.name))]
  for (const dir of dirs) {
    const file = path.join(dir, target)
    if (!fs.existsSync(file)) continue
    let record
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { skipped++; continue }
    // JSON.parse('null') succeeds and yields null, and reading a property off
    // it threw an uncaught error that aborted the whole verb. A record that is
    // not an object carries no socket information at all, which is the UNKNOWN
    // case described above, so it is skipped rather than deleted.
    if (!record || typeof record !== 'object') { skipped++; continue }
    const sock = record?.socketPath || ''
    if (sock && fs.existsSync(sock)) continue
    try { fs.unlinkSync(file); removed++ } catch {}
  }
  return { removed, skipped, dirMissing: false }
}
