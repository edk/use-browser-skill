import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { tokenPath } from '../../lib/token.js'
import { row, listFile } from './list-fixture.js'

const CLI = path.resolve('bin/pwx.js')
const STUB = path.resolve('test/stub/playwright-cli.js')
const TOKEN = 'super-secret-cli-test-token-value'

// Pipes `stdin` in (never an argv), same shape as `pwx token set < file` or
// `echo "$TOKEN" | pwx token set` — the whole point of the safe shape the
// task asked for.
function runIn (root, args, { env = {}, stdin = null } = {}) {
  const log = path.join(root, 'log')
  return new Promise(resolvePromise => {
    const child = execFile(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        PW_BIN: STUB,
        PW_STUB_LOG: log,
        PW_STATE_ROOT: root,
        PW_SCRATCH_DIR: path.join(root, 'scratch'),
        CLAUDE_CODE_SESSION_ID: 'sess1',
        PLAYWRIGHT_MCP_EXTENSION_TOKEN: '',
        ...env
      }
    }, (err, stdout, stderr) => {
      const calls = fs.existsSync(log)
        ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
        : []
      resolvePromise({ code: err?.code ?? 0, stdout, stderr, calls })
    })
    if (stdin !== null) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

const mkroot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-clitoken-'))

test("'pwx token set' reads the token from stdin, not an argv, and stores it owner-only", async () => {
  const root = mkroot()
  const r = await runIn(root, ['token', 'set'], { stdin: `${TOKEN}\n` })
  assert.equal(r.code, 0, r.stderr)
  const file = tokenPath({ stateRoot: root })
  assert.equal(fs.readFileSync(file, 'utf8').trim(), TOKEN)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test("'pwx token set' never prints the token it just stored", async () => {
  const root = mkroot()
  const r = await runIn(root, ['token', 'set'], { stdin: `${TOKEN}\n` })
  assert.ok(!r.stdout.includes(TOKEN), 'stdout must not contain the token')
  assert.ok(!r.stderr.includes(TOKEN), 'stderr must not contain the token')
})

test("'pwx token set' with empty stdin refuses rather than storing nothing silently", async () => {
  const root = mkroot()
  const r = await runIn(root, ['token', 'set'], { stdin: '' })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /no token read from stdin/)
  assert.equal(fs.existsSync(tokenPath({ stateRoot: root })), false)
})

test("'pwx token clear' removes a stored token and says so; a second clear is a no-op that says so too", async () => {
  const root = mkroot()
  await runIn(root, ['token', 'set'], { stdin: `${TOKEN}\n` })
  const r1 = await runIn(root, ['token', 'clear'])
  assert.equal(r1.code, 0, r1.stderr)
  assert.match(r1.stdout, /cleared the stored extension token/)
  assert.equal(fs.existsSync(tokenPath({ stateRoot: root })), false)
  const r2 = await runIn(root, ['token', 'clear'])
  assert.equal(r2.code, 0)
  assert.match(r2.stdout, /no stored extension token file to clear/)
})

test("bare 'pwx token' prints usage for set/clear rather than doing either", async () => {
  const root = mkroot()
  const r = await runIn(root, ['token'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /pwx token set/)
  assert.match(r.stdout, /pwx token clear/)
  assert.equal(fs.existsSync(tokenPath({ stateRoot: root })), false)
})

test("'pwx status' reports a token configured from the environment, never its value", async () => {
  const root = mkroot()
  const r = await runIn(root, ['status'], { env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: TOKEN } })
  assert.match(r.stdout, /extension token: configured \(from PLAYWRIGHT_MCP_EXTENSION_TOKEN env var\)/)
  assert.ok(!r.stdout.includes(TOKEN))
})

test("'pwx status' reports a token configured from the file, never its value", async () => {
  const root = mkroot()
  await runIn(root, ['token', 'set'], { stdin: `${TOKEN}\n` })
  const r = await runIn(root, ['status'])
  assert.match(r.stdout, /extension token: configured \(from file: /)
  assert.ok(!r.stdout.includes(TOKEN))
})

test("'pwx status' reports no token configured when neither env nor file is set", async () => {
  const root = mkroot()
  const r = await runIn(root, ['status'])
  assert.match(r.stdout, /extension token: not configured/)
})

test("'pwx status' refuses to treat an insecurely-permissioned token file as configured, and never prints its contents", async () => {
  const root = mkroot()
  await runIn(root, ['token', 'set'], { stdin: `${TOKEN}\n` })
  fs.chmodSync(tokenPath({ stateRoot: root }), 0o644)
  const r = await runIn(root, ['status'])
  assert.match(r.stdout, /extension token: NOT USED/)
  assert.match(r.stdout, /broader than owner-only/)
  assert.ok(!r.stdout.includes(TOKEN))
})

test("attach uses a token stored via 'pwx token set' (no PLAYWRIGHT_MCP_EXTENSION_TOKEN in env), and never prints it", async () => {
  const root = mkroot()
  await runIn(root, ['token', 'set'], { stdin: `${TOKEN}\n` })
  const r = await runIn(root, ['attach'], { env: { PW_STUB_LIST: listFile(root, []) } })
  assert.equal(r.code, 0, r.stderr)
  assert.doesNotMatch(r.stderr, /no extension token configured/)
  assert.ok(!r.stdout.includes(TOKEN), 'stdout must not contain the token')
  assert.ok(!r.stderr.includes(TOKEN), 'stderr must not contain the token')
})

test('attach refuses to use a token file with overly broad permissions rather than silently reading it', async () => {
  const root = mkroot()
  await runIn(root, ['token', 'set'], { stdin: `${TOKEN}\n` })
  fs.chmodSync(tokenPath({ stateRoot: root }), 0o644)
  const r = await runIn(root, ['attach'], { env: { PW_STUB_LIST: listFile(root, []) } })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /broader than owner-only/)
  assert.ok(!r.stderr.includes(TOKEN))
  assert.ok(!r.calls.some(c => c.argv.includes('attach')), 'must never run the engine attach call with an insecure token')
})

// --- the token must never reach stdout/stderr across a spread of verbs ---

for (const [label, args] of [['status', ['status']], ['token usage', ['token']], ['token clear', ['token', 'clear']], ['help', ['help']]]) {
  test(`${label}: the token never appears in stdout or stderr, whether from env or file`, async () => {
    const rootEnv = mkroot()
    const rEnv = await runIn(rootEnv, args, { env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: TOKEN } })
    assert.ok(!rEnv.stdout.includes(TOKEN) && !rEnv.stderr.includes(TOKEN), `${label} (env) leaked the token`)

    const rootFile = mkroot()
    await runIn(rootFile, ['token', 'set'], { stdin: `${TOKEN}\n` })
    const rFile = await runIn(rootFile, args)
    assert.ok(!rFile.stdout.includes(TOKEN) && !rFile.stderr.includes(TOKEN), `${label} (file) leaked the token`)
  })
}
