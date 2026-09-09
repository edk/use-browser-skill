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

// `headless` defaults to forcing the environment override on, which is what
// most cases want: they are not about mode, and a stray visible window during a
// test run is worse than the lost fidelity. Pass `headless: null` to remove the
// override entirely, which is the ONLY way to test that the mode file decides
// anything — PLAYWRIGHT_MCP_HEADLESS beats the mode file in config resolution,
// so a mode-file assertion made with it set passes whether or not the mode file
// was ever written.
export function pwx (args, { root, sessionId, browser, headless = 'true' }) {
  const env = {
    ...process.env,
    PW_STATE_ROOT: root,
    PW_SCRATCH_DIR: path.join(root, 'scratch'),
    CLAUDE_CODE_SESSION_ID: sessionId,
    PW_BROWSER: browser,
    PLAYWRIGHT_MCP_HEADLESS: headless
  }
  if (headless === null) delete env.PLAYWRIGHT_MCP_HEADLESS
  return new Promise(resolve => {
    execFile(process.execPath, [path.resolve('bin/pwx.js'), ...args], { env, timeout: 120000 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }))
  })
}

// Read this session's row out of `list --json`, the same structured output the
// tool itself reads. Returns null when the session is not listed.
export async function listRow (name, opts) {
  const r = await pwx(['list', '--json'], opts)
  let payload
  try { payload = JSON.parse(r.stdout) } catch {
    throw new Error(`list --json did not return JSON (code ${r.code}): ${r.stdout}${r.stderr}`)
  }
  return payload.browsers.find(b => b.name === name) ?? null
}

export const mkroot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-i-'))
