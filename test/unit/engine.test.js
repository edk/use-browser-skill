import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseBrowsers, sessionRow, sessionState, sessionHeaded, clearSessionCache, run } from '../../lib/engine.js'
import { row, payload, render, listFile } from './list-fixture.js'

const STUB = path.resolve('test/stub/playwright-cli.js')
const mkctx = over => ({
  bin: STUB, session: 'pw-a', scratchDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-s-')),
  headless: false, daemonDir: '/nonexistent', ...over
})

const OPEN_HEADED = row('pw-a', { headed: true })
const OTHER = row('pw-b', { status: 'closed', headed: false })

test('parseBrowsers reads the real --json shape', () => {
  const rows = parseBrowsers(payload([OPEN_HEADED, OTHER]))
  assert.equal(rows.length, 2)
  assert.deepEqual(sessionRow(rows, 'pw-a'), OPEN_HEADED)
  assert.equal(sessionRow(rows, 'pw-zz'), null)
})

test('parseBrowsers reports could-not-tell, never an empty registry, for output it cannot read', () => {
  // Each of these once had to be distinguishable from {"browsers": []}: an
  // empty array licenses a caller to reap whatever holds the profile.
  for (const bad of ['', 'not json', 'null', '[]', '{}', '{"browsers": 3}', render([OPEN_HEADED])]) {
    assert.equal(parseBrowsers(bad), null, JSON.stringify(bad))
  }
  assert.deepEqual(parseBrowsers(payload([])), [], 'a real empty registry is a real answer')
})

test('parseBrowsers reads unknown, not closed, when a non-empty registry yields no usable row', () => {
  // The direction that already burned this tool once: an upstream rename of
  // the `name` field would make every row fail the shape check below, and
  // collapsing that into [] reads as "closed" — licensing a caller to kill
  // whatever holds the profile. A non-empty browsers array that filters down
  // to nothing must read as could-not-tell instead.
  const renamedField = JSON.stringify({ browsers: [{ label: 'pw-a', status: 'open', headed: true }] })
  assert.equal(parseBrowsers(renamedField), null)
  const missingName = JSON.stringify({ browsers: [{ status: 'open' }, { status: 'closed' }] })
  assert.equal(parseBrowsers(missingName), null)
  // A genuinely empty array is still the real "no sessions" answer.
  assert.deepEqual(parseBrowsers(JSON.stringify({ browsers: [] })), [])
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

test('sessionState reads a live session as open', async () => {
  // The regression test for the defect that shipped: the fixture is the exact
  // payload the real CLI returns for a session that is genuinely open. The
  // previous parser read this as closed, and `open` then reaped the running
  // browser and relaunched, losing any login it was holding.
  const ctx = mkctx()
  const file = listFile(ctx.scratchDir, [OPEN_HEADED])
  assert.equal(await sessionState(ctx, { env: { PW_STUB_LIST: file } }), 'open')
  assert.equal(await sessionHeaded(ctx, { env: { PW_STUB_LIST: file } }), true)
})

test('sessionState reads closed for a row that is not open and for a session that is absent', async () => {
  const ctx = mkctx()
  const file = listFile(ctx.scratchDir, [OPEN_HEADED, OTHER])
  assert.equal(await sessionState({ ...ctx, session: 'pw-b' }, { env: { PW_STUB_LIST: file } }), 'closed')
  const empty = listFile(ctx.scratchDir, [], 'empty.json')
  assert.equal(await sessionState(ctx, { env: { PW_STUB_LIST: empty } }), 'closed')
})

test('sessionState refuses to read the rendered text form as closed', async () => {
  // Belt and braces on the same defect from the other side: if a future change
  // ever drops --json, every caller must fall back to "unknown" (refuse to
  // act), not to "closed" (free to kill the browser).
  const ctx = mkctx()
  const file = path.join(ctx.scratchDir, 'rendered.txt')
  fs.writeFileSync(file, render([OPEN_HEADED]))
  assert.equal(await sessionState(ctx, { env: { PW_STUB_LIST: file }, sleep: async () => {} }), 'unknown')
})

test('sessionHeaded reports false, not a throw, when list cannot be read', async () => {
  const ctx = mkctx()
  assert.equal(await sessionHeaded(ctx, { env: { PW_STUB_EXIT: '3' } }), false)
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

test('clearSessionCache skips, but does not delete, a record it cannot parse', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-d-'))
  const file = path.join(dir, 'pw-a.session')
  fs.writeFileSync(file, '{ not valid json')
  const res = await clearSessionCache({ ...mkctx(), daemonDir: dir })
  assert.equal(res.removed, 0)
  assert.equal(res.skipped, 1)
  assert.equal(fs.existsSync(file), true)
})

test('clearSessionCache survives a record that parses to a non-object', async () => {
  // JSON.parse('null') succeeds; reading .socketPath off it threw an uncaught
  // error that aborted the whole verb before the browser was ever launched.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-d-'))
  for (const [name, body] of [['pw-a.session', 'null'], ['pw-b.session', '"a string"']]) {
    fs.writeFileSync(path.join(dir, name), body)
  }
  for (const session of ['pw-a', 'pw-b']) {
    const res = await clearSessionCache({ ...mkctx(), session, daemonDir: dir })
    assert.equal(res.skipped, 1)
    assert.equal(res.removed, 0)
    assert.equal(fs.existsSync(path.join(dir, `${session}.session`)), true)
  }
})

test('clearSessionCache deletes a valid record with no socketPath', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-d-'))
  const file = path.join(dir, 'pw-a.session')
  fs.writeFileSync(file, JSON.stringify({ persistent: true }))
  const res = await clearSessionCache({ ...mkctx(), daemonDir: dir })
  assert.equal(res.removed, 1)
  assert.equal(res.skipped, 0)
  assert.equal(fs.existsSync(file), false)
})
