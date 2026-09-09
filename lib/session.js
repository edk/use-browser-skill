import fs from 'node:fs'
import path from 'node:path'
import { listProcesses as defaultList, killPids } from './procs.js'
import { get } from './browsers/index.js'
import { DIR_MODE, FILE_MODE, restrictPath, mkdirPrivate } from './fsutil.js'

// Re-exported so existing callers (bin/pwx.js, tests) keep reading these off
// session.js. The mechanism itself lives in lib/fsutil.js, shared with
// lib/engine.js, so the two never need to import each other.
export { restrictPath, mkdirPrivate } from './fsutil.js'

export function dirHasContent (dir) {
  try { return fs.readdirSync(dir).length > 0 } catch { return false }
}

// pwx's state holds a browser profile and, next to it, a storage-state
// snapshot of session cookies in PLAINTEXT — unlike Chromium's own cookie
// store, which is encrypted with a key from the OS keychain. Written with
// default modes, that snapshot is readable by every other local account on a
// shared machine. So pwx creates its own directories owner-only (via
// mkdirPrivate, from lib/fsutil.js) and sets the snapshot owner-only after
// each write.

export function restrictSnapshot (profileDir, platform = process.platform) {
  restrictPath(snapshotPath(profileDir), FILE_MODE, platform)
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
//
// The storage-state snapshot (see snapshotPath below) lives inside the
// profile directory itself, alongside Default/, so it rides along with this
// same recursive copy rather than as a second, separately-timed write. That
// is what keeps the snapshot and the profile from ever disagreeing about
// which run they came from: they are copied, staged, and renamed as one unit
// by promote() and seedFromGolden() below.
export async function copyProfile (src, dst, adapter, deps = {}) {
  const cp = deps.cp || fs.promises.cp
  try {
    const skip = new Set(expandPrune(src, adapter.pruneDirs).map(p => path.resolve(src, p)))
    await cp(src, dst, {
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

// Where the live storage-state snapshot lives, relative to a profile
// directory (session or golden). A dotfile name that neither Chromium's nor
// Firefox's own profile layout uses, so it never collides with real browser
// state and is easy to recognise as pwx's own.
export function snapshotPath (profileDir) {
  return path.join(profileDir, '.pwx-storage-state.json')
}

// Marker recording that a freshly seeded session has a snapshot waiting to be
// applied to the live browser on its first launch. Lives in stateDir, not
// profileDir, so it is never itself carried along by copyProfile — it is a
// per-session flag about what THIS session still owes its browser, not part
// of the state to hand to the next session.
export function statePendingPath (ctx) {
  return path.join(ctx.stateDir, 'state-pending')
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
  try {
    await fs.promises.rename(flat, staging)
    await fs.promises.mkdir(flat, { recursive: true })
    await fs.promises.rename(staging, path.join(flat, 'chromium'))
    return true
  } catch {
    // A failure between the two renames must not strand the legacy golden at
    // `golden.migrating.<pid>`: every later call would read its absence as "no
    // golden exists" rather than "golden misplaced". Move it back if we can.
    if (dirHasContent(staging) && !dirHasContent(flat)) {
      await fs.promises.rm(flat, { recursive: true, force: true }).catch(() => {})
      await fs.promises.rename(staging, flat).catch(() => {})
    }
    return false
  }
}

export async function seedFromGolden (ctx, adapter, deps = {}) {
  if (!ctx.isolated || !ctx.seed || ctx.ephemeral) return 'skipped'
  if (fs.existsSync(path.join(ctx.stateDir, 'no-seed'))) return 'skipped'
  if (dirHasContent(ctx.profileDir)) return 'skipped'
  await migrateGolden(ctx).catch(() => {})
  if (!dirHasContent(ctx.goldenDir)) return 'skipped'
  const staging = `${ctx.profileDir}.seeding.${process.pid}`
  mkdirPrivate(path.dirname(ctx.profileDir), ctx.platform)
  await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
  // Stage then rename: an interrupted copy must not leave a half profile that
  // the next launch mistakes for an already-seeded one.
  if (!await copyProfile(ctx.goldenDir, staging, adapter, deps)) {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
    return 'failed'
  }
  // Try the rename FIRST, and never remove a populated profile to make room
  // for it. Two opens in one session can both pass the empty-profile check
  // above; deleting the destination here meant the second one wiped the
  // first's freshly seeded profile, possibly while the first browser was
  // already launching on it. rmdir (not rm -r) is safe because it fails on a
  // non-empty directory, and it is needed on Windows, where rename fails onto
  // an existing directory even when that directory is empty.
  try { fs.rmdirSync(ctx.profileDir) } catch {}
  try {
    await fs.promises.rename(staging, ctx.profileDir)
  } catch {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
    // Lost the race. The winner copied the same golden we did, so its profile
    // is ours for every purpose; leave it alone and report success. The winner
    // writes its own pending marker.
    return dirHasContent(ctx.profileDir) ? 'seeded' : 'failed'
  }
  restrictPath(ctx.profileDir, DIR_MODE, ctx.platform)
  restrictSnapshot(ctx.profileDir, ctx.platform)
  // The snapshot rode in with the profile copy above (same directory tree).
  // If golden had one, mark it pending so the first launch of this session
  // applies it to the live browser before anything else. Best-effort: a
  // marker that fails to write just means this session starts from the
  // disk-only profile, same as before this feature existed.
  if (fs.existsSync(snapshotPath(ctx.profileDir))) {
    mkdirPrivate(ctx.stateDir, ctx.platform)
    await fs.promises.writeFile(statePendingPath(ctx), '').catch(() => {})
  }
  return 'seeded'
}

export async function promote (ctx, adapter, deps = {}) {
  const rename = deps.rename || fs.promises.rename
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
  mkdirPrivate(path.dirname(ctx.goldenDir), ctx.platform)
  if (!await copyProfile(ctx.profileDir, staging, adapter, deps)) {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
    return { ok: false, error: 'copy failed', cookies: null }
  }

  const old = `${ctx.goldenDir}.old`
  // A previous promote's install can have failed with its own restore also
  // failing, leaving the real golden stranded here while the golden path sits
  // empty. Recover it instead of deleting it: destroying it here is the one
  // truly unrecoverable failure, since golden holds every future session's
  // saved logins. Only delete `old` when the golden already has content, i.e.
  // it is ordinary leftover trash from a promote that already succeeded.
  if (fs.existsSync(old)) {
    if (dirHasContent(ctx.goldenDir)) {
      await fs.promises.rm(old, { recursive: true, force: true }).catch(() => {})
    } else {
      await rename(old, ctx.goldenDir).catch(() => {})
      // Guard 1: verify the recovery landed instead of assuming it did. If the
      // rename itself failed (EACCES, EBUSY, ...), rename's atomicity means
      // `old` still holds the only surviving copy intact — do not fall through
      // into a fresh install, which would later delete this backup on a false
      // success. A promote failing is always better than a promote destroying
      // a backup it could not recover.
      if (!dirHasContent(ctx.goldenDir)) {
        await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
        return {
          ok: false,
          error: `could not recover the stranded golden backup at ${old}. Move it to ${ctx.goldenDir} by hand, then retry promote.`,
          cookies: null
        }
      }
    }
  }

  // Guard 2: track explicitly whether THIS call is the one that moved the
  // golden aside, rather than inferring it from golden's earlier state. Only
  // a backup this call created is this call's to delete.
  //
  // Under the control flow as it stands, movedAsideThisCall and hadGolden are
  // always equal, so this flag never differentiates anything and the check
  // below it is unreachable as a distinct branch. It is kept deliberately.
  // This is the one operation in pwx that can destroy user data that exists
  // nowhere else — golden holds every future session's saved logins — and the
  // cost of the guard is a boolean, while the cost of some later edit
  // reintroducing the inference is an unrecoverable deletion.
  let movedAsideThisCall = false
  const hadGolden = dirHasContent(ctx.goldenDir)
  if (hadGolden) {
    try {
      await rename(ctx.goldenDir, old)
      movedAsideThisCall = true
    } catch (err) {
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
      return { ok: false, error: `could not move the current golden profile aside: ${err.message}`, cookies: null }
    }
  }

  // Windows fails a rename onto an existing directory even when it is empty,
  // so an existing-but-empty golden made every promote into it fail. Removing
  // an empty directory destroys nothing, and rmdir refuses on a non-empty one.
  // hadGolden is false here by construction: "empty" is what dirHasContent
  // said no to.
  if (!hadGolden) { try { fs.rmdirSync(ctx.goldenDir) } catch {} }
  try {
    await rename(staging, ctx.goldenDir)
  } catch {
    // Restoring matters more than the promote: the old golden holds the saved
    // logins of every future session. Verify the restore before claiming it in
    // the error, and never delete `old` on this path: if the restore itself
    // fails, the backup must survive for the user or the next promote to
    // recover.
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
    if (!hadGolden) {
      return { ok: false, error: 'could not install golden profile', cookies: null }
    }
    await rename(old, ctx.goldenDir).catch(() => {})
    if (dirHasContent(ctx.goldenDir)) {
      return { ok: false, error: 'could not install golden profile (previous golden restored)', cookies: null }
    }
    return {
      ok: false,
      error: `could not install golden profile, and restoring the previous golden also failed. Your previous golden profile is preserved at ${old} — move it back to ${ctx.goldenDir} by hand.`,
      cookies: null
    }
  }
  if (movedAsideThisCall) {
    await fs.promises.rm(old, { recursive: true, force: true }).catch(() => {})
  }
  restrictPath(ctx.goldenDir, DIR_MODE, ctx.platform)
  restrictSnapshot(ctx.goldenDir, ctx.platform)
  return { ok: true, cookies: await adapter.cookieCount(ctx.goldenDir) }
}

// A session dir goes only when it is not ours, has no live browser, is not open
// in the registry, and has gone unused for the TTL.
//
// `rows` is the parsed `list --json` array (engine.parseBrowsers' shape), or
// null for "could not tell" — the same rows engine.sessionState reads, so the
// sweep and session-state checks can never disagree about who is open. This
// is deliberately not engine.listSessions/parseBrowsers imported directly:
// session.js and engine.js stay free of a circular import, so the caller
// (bin/pwx.js, which already imports both) fetches the rows and passes them
// in. A session dir whose name appears anywhere in `rows` must never be
// swept — that is the guard that stops this from deleting a session that is
// currently open. When rows is null, there is no way to check that guard, so
// the row-match-protected removal is skipped entirely rather than run
// unprotected; the unrelated pid-liveness cleanup of interrupted seeds below
// still runs, since it never depended on the listing.
export async function sweepStale (ctx, { rows = null, now = Date.now() / 1000, deps = {} } = {}) {
  const root = path.join(ctx.stateRoot, 'sessions')
  let kids = []
  try { kids = fs.readdirSync(root, { withFileTypes: true }) } catch { return 0 }
  let removed = 0
  if (rows !== null) {
    for (const ent of kids) {
      if (!ent.isDirectory()) continue
      const key = ent.name
      if (key === ctx.sessionKey) continue
      const dir = path.join(root, key)
      const listedName = `pw-${key}`
      if (rows.some(row => row && row.name === listedName)) continue
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
    mkdirPrivate(ctx.stateDir, ctx.platform)
    fs.writeFileSync(path.join(ctx.stateDir, 'last-used'), String(Math.floor(Date.now() / 1000)))
  } catch {}
}

export function recordBrowser (ctx) {
  try {
    mkdirPrivate(ctx.stateDir, ctx.platform)
    fs.writeFileSync(path.join(ctx.stateDir, 'browser'), `${ctx.browser}\n`)
  } catch {}
}

export function setMode (ctx, mode) {
  try {
    mkdirPrivate(ctx.stateDir, ctx.platform)
    fs.writeFileSync(path.join(ctx.stateDir, 'mode'), `${mode}\n`)
  } catch {}
}

// Capture is best-effort in the same sense promote's cookie warning already
// describes: state-save reads the LIVE session over the daemon's own
// connection (Task 10 proved `cookie-list` does this correctly right after a
// page sets a cookie), so it does not depend on Chromium ever flushing its
// on-disk cookie store. `run` is engine.run, passed in rather than imported
// so this stays testable against the stub without a circular import between
// session.js and engine.js.
//
// A browser that will not close is a worse outcome than a missing snapshot,
// so every failure here is swallowed. Callers must not branch on the result
// to decide whether to proceed with the close.
export async function captureStorageState (ctx, run) {
  if (ctx.ephemeral) return false
  try {
    mkdirPrivate(ctx.profileDir, ctx.platform)
    const r = await run(ctx, ['state-save', snapshotPath(ctx.profileDir)], { capture: true })
    // Plaintext cookies: tighten the file the moment it exists, whatever mode
    // playwright-cli wrote it with.
    restrictSnapshot(ctx.profileDir, ctx.platform)
    return r.code === 0
  } catch {
    return false
  }
}

// Apply is best-effort the same way: a session that starts logged out is
// recoverable, one that will not start is not. The pending marker is cleared
// whether or not state-load actually succeeds — an apply that is attempted
// once and fails must not turn into a retry on every later open, since a
// broken snapshot would otherwise wedge every future launch into repeating
// the same failure forever. Returns 'none' | 'applied' | 'failed' for the
// caller to log, never to gate on.
export async function applyPendingState (ctx, run) {
  const marker = statePendingPath(ctx)
  if (!fs.existsSync(marker)) return 'none'
  let applied = false
  try {
    const snapshot = snapshotPath(ctx.profileDir)
    if (fs.existsSync(snapshot)) {
      const r = await run(ctx, ['state-load', snapshot], { capture: true })
      applied = r.code === 0
    }
  } catch {
    applied = false
  } finally {
    await fs.promises.rm(marker, { force: true }).catch(() => {})
  }
  return applied ? 'applied' : 'failed'
}
