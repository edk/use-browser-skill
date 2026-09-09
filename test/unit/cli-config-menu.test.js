import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { runMenu } from '../../lib/menu.js'
import { Readable, Writable } from 'node:stream'

const CLI = path.resolve('bin/pwx.js')
const STUB = path.resolve('test/stub/playwright-cli.js')
const mkroot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-cm-'))

function runIn (root, args) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, PW_BIN: STUB, PW_STATE_ROOT: root, PW_SCRATCH_DIR: path.join(root, 's'), CLAUDE_CODE_SESSION_ID: 'sess1' }
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }))
  })
}

function fakeIO (lines) {
  const input = Readable.from(lines.map(l => l + '\n'))
  let out = ''
  const output = new Writable({ write (c, e, cb) { out += c; cb() } })
  return { input, output, read: () => out }
}

test('config prints value and source', async () => {
  const root = mkroot()
  const r = await runIn(root, ['config'])
  assert.match(r.stdout, /browser\s+chromium\s+default/)
})

test('config set writes config.json and takes effect', async () => {
  const root = mkroot()
  await runIn(root, ['config', 'set', 'browser', 'firefox'])
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).browser, 'firefox')
  const r = await runIn(root, ['config'])
  assert.match(r.stdout, /browser\s+firefox\s+config/)
})

test('config set rejects an unknown key and an invalid browser', async () => {
  const root = mkroot()
  assert.equal((await runIn(root, ['config', 'set', 'colour', 'blue'])).code, 2)
  const bad = await runIn(root, ['config', 'set', 'browser', 'webkit'])
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /unsupported browser 'webkit'/)
})

test('config set accepts chrome and msedge as browser values', async () => {
  const root = mkroot()
  await runIn(root, ['config', 'set', 'browser', 'chrome'])
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).browser, 'chrome')
  assert.match((await runIn(root, ['config'])).stdout, /browser\s+chrome\s+config/)

  await runIn(root, ['config', 'set', 'browser', 'msedge'])
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).browser, 'msedge')
  assert.match((await runIn(root, ['config'])).stdout, /browser\s+msedge\s+config/)
})

test('menu maps a numbered choice plus a URL prompt to argv', async () => {
  const io = fakeIO(['1', 'https://example.test'])
  const argv = await runMenu({ browser: 'chromium', session: 'pw-x' }, io)
  assert.deepEqual(argv, ['open', 'https://example.test'])
  assert.match(io.read(), /1\) open/)
})

test('menu quits on q and re-prompts on a bad choice', async () => {
  assert.deepEqual(await runMenu({ browser: 'chromium', session: 'pw-x' }, fakeIO(['q'])), [])
  const io = fakeIO(['99', 'q'])
  assert.deepEqual(await runMenu({ browser: 'chromium', session: 'pw-x' }, io), [])
  assert.match(io.read(), /not a choice/)
})
