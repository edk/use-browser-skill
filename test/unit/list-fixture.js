import fs from 'node:fs'
import path from 'node:path'

// Captured verbatim from `playwright-cli list --json` (@playwright/cli 0.1.19)
// against a live headless session. Fixtures are built from this rather than
// hand-written, because the defect these tests exist to catch was a fake list
// format the tool never emits: the old single-line fixtures passed against a
// parser that could not read a real live session at all.
export const REAL_ROW = {
  name: 'pw-verify123',
  workspace: '79a368e9c4c3ab0e',
  status: 'open',
  browserType: 'chrome-for-testing',
  userDataDir: '/tmp/pwx/sessions/verify123/profile',
  headed: false,
  persistent: true,
  attached: false,
  compatible: true,
  version: '1.63.0-alpha-2026-08-31'
}

export function row (name, over = {}) {
  return { ...REAL_ROW, name, userDataDir: `/tmp/pwx/sessions/${name}/profile`, ...over }
}

export function payload (rows = []) {
  return JSON.stringify({ browsers: rows }, null, 2) + '\n'
}

// The rendered, human-readable form the CLI prints without --json. Kept only
// so tests can prove we do NOT parse it; nothing in lib/ reads this shape.
export function render (rows = []) {
  if (!rows.length) return '  (no browsers)\n'
  let out = '### Browsers\n'
  for (const b of rows) {
    out += `- ${b.name}:\n  - status: ${b.status}\n  - browser-type: ${b.browserType}\n`
    out += `  - user-data-dir: ${b.userDataDir}\n  - headed: ${b.headed === true}\n`
  }
  return out
}

// Write a `list --json` fixture. `rows` is an array of row objects; an empty
// array is the real answer for an empty registry, and is what "this session is
// not open" looks like — a closed session is simply absent from the list.
export function listFile (dir, rows = [], name = 'list.json') {
  const f = path.join(dir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(f, payload(rows))
  return f
}
