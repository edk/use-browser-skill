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

// PW_STUB_LIST names a file holding the JSON `list --json` payload, i.e.
// {"browsers":[{name, workspace, status, browserType, userDataDir, headed,
// persistent, attached, compatible, version}]}. One fixture drives both output
// modes: `--json` replays it verbatim, and a bare `list` renders it in the real
// CLI's indented multi-line form. Keeping the render here rather than in the
// fixtures is what stops a test from inventing a shape the tool never emits —
// a single-line fake list is exactly how a live session came to read as closed.
function render (payload) {
  const rows = payload.browsers ?? []
  if (!rows.length) return '  (no browsers)\n'
  let out = '### Browsers\n'
  for (const b of rows) {
    out += `- ${b.name}:\n`
    out += `  - status: ${b.status}\n`
    out += `  - browser-type: ${b.browserType ?? 'chrome-for-testing'}\n`
    out += `  - user-data-dir: ${b.userDataDir ?? '<in-memory>'}\n`
    out += `  - headed: ${b.headed === true}\n`
  }
  return out
}

if (argv[0] === 'list' && process.env.PW_STUB_LIST) {
  const raw = fs.readFileSync(process.env.PW_STUB_LIST, 'utf8')
  if (argv.includes('--json')) process.stdout.write(raw)
  else {
    let payload
    try { payload = JSON.parse(raw) } catch { payload = null }
    process.stdout.write(payload ? render(payload) : raw)
  }
}
// Opt-in, per-verb failure so a test can fail e.g. only `state-save` without
// also failing `close`/`open` in the same run — PW_STUB_EXIT fails every
// call uniformly, which is too blunt for testing a single best-effort step.
const failVerbs = new Set((process.env.PW_STUB_FAIL_VERBS ?? '').split(',').map(s => s.trim()).filter(Boolean))
if (argv.some(a => failVerbs.has(a))) process.exit(1)
process.exit(Number(process.env.PW_STUB_EXIT ?? 0))
