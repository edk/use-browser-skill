import fs from 'node:fs'

// Shared ownership-restriction helpers for directories pwx creates outside a
// user's own home tree. A directory created at the platform default mode
// under a shared, world-writable location — /tmp on Linux, for instance —
// is readable and writable by every other local account on the machine, and
// its fixed, predictable name invites a pre-created directory or a symlink
// planted by another user.
//
// Both lib/session.js (profile and golden directories, which hold a
// plaintext cookie snapshot) and lib/engine.js (the scratch directory, which
// holds command output and artifacts) need this same treatment, so it lives
// here rather than in either of those two files: they are deliberately kept
// free of a circular import between them.
//
// POSIX only. Windows ignores the mode argument to mkdir and chmod, and its
// ACL model is not something a mode bitmask can express, so this is a no-op
// there rather than an error. Failures are swallowed for the same reason:
// a browser (or command) that will not run at all is a worse outcome than a
// permission that stayed at the platform default.
export const DIR_MODE = 0o700
export const FILE_MODE = 0o600

export function restrictPath (target, mode, platform = process.platform) {
  if (platform === 'win32') return
  try { fs.chmodSync(target, mode) } catch {}
}

// mkdir's `mode` applies only to directories this call creates, so an existing
// directory is tightened separately.
export function mkdirPrivate (dir, platform = process.platform) {
  try {
    fs.mkdirSync(dir, { recursive: true, ...(platform === 'win32' ? {} : { mode: DIR_MODE }) })
  } catch {}
  restrictPath(dir, DIR_MODE, platform)
}
