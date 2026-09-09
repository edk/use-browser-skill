import fs from 'node:fs'
import path from 'node:path'
import { FILE_MODE, restrictPath, mkdirPrivate } from './fsutil.js'

// PLAYWRIGHT_MCP_EXTENSION_TOKEN bypasses the browser extension's own
// approval dialog, so it is a credential: anything running as the owner can
// use it to drive their browser silently, with no click to notice. This
// module is the one place pwx resolves, stores, or clears that value — no
// other file may read process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN or this
// token file directly, and nothing here ever writes the value to stdout,
// stderr, a log, or an error message. Callers get the token itself (to hand
// to the engine's child-process env, never to print) or a description of
// where it came from / why it was refused, never the raw value alongside
// prose.

// Stored under the tool's own state root, not any per-agent session
// directory: it is the owner's one credential for their one real browser,
// shared by every Claude session the same way the browser connection itself
// is (see ATTACH_SESSION_NAME in lib/config.js).
export function tokenPath (ctx) {
  return path.join(ctx.stateRoot, 'extension-token')
}

function readTrimmed (file) {
  try { return fs.readFileSync(file, 'utf8').trim() } catch { return '' }
}

// Returns { token, source, error }:
//  - token: the resolved value, or null if none is available (never printed
//    by any caller; treat it as opaque).
//  - source: 'env' | 'file' | null.
//  - error: null, or { path, mode } when a token FILE exists but its
//    permissions are broader than owner-only — refused rather than read, so
//    callers must not fall back to treating this as "no token configured"
//    (that would silently mask a real misconfiguration).
export function resolveExtensionToken (ctx, env = process.env) {
  // Environment wins outright: if it's already set, the file is never even
  // looked at, let alone read — matches "use it unchanged" and means a
  // loosely-permissioned leftover file can never override an explicit,
  // intentional env value.
  const fromEnv = env.PLAYWRIGHT_MCP_EXTENSION_TOKEN
  if (fromEnv) return { token: fromEnv, source: 'env', error: null }

  const file = tokenPath(ctx)
  let stat
  try { stat = fs.statSync(file) } catch { return { token: null, source: null, error: null } }

  const mode = stat.mode & 0o777
  // Owner-only means no group/other bits at all (0600, or tighter like 0400).
  // Windows ignores POSIX mode bits entirely (fsutil.js's restrictPath is
  // already a no-op there), so this check would see whatever placeholder
  // mode Node reports and could misfire; it only runs on POSIX.
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    return { token: null, source: null, error: { path: file, mode } }
  }

  const value = readTrimmed(file)
  if (!value) return { token: null, source: null, error: null }
  return { token: value, source: 'file', error: null }
}

// Writes (or overwrites) the token file, owner-only, regardless of whatever
// permissions an existing file had — fs.writeFileSync's `mode` option only
// applies when it creates the file, so an explicit chmod afterward (via
// restrictPath, the same helper session.js uses for the profile/golden
// directories and the storage-state snapshot) is what actually guarantees
// owner-only on an overwrite.
export function writeExtensionToken (ctx, token, platform = process.platform) {
  mkdirPrivate(ctx.stateRoot, platform)
  const file = tokenPath(ctx)
  fs.writeFileSync(file, `${token}\n`, { mode: FILE_MODE })
  restrictPath(file, FILE_MODE, platform)
  return file
}

export function clearExtensionToken (ctx) {
  const file = tokenPath(ctx)
  const existed = fs.existsSync(file)
  fs.rmSync(file, { force: true })
  return existed
}
