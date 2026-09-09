import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

test('stub records argv and env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-t-'))
  const log = path.join(dir, 'log')
  execFileSync(process.execPath, ['test/stub/playwright-cli.js', 'list', '-s=pw-x'], {
    env: { ...process.env, PW_STUB_LOG: log, PLAYWRIGHT_MCP_HEADLESS: 'true' }
  })
  const rec = JSON.parse(fs.readFileSync(log, 'utf8').trim())
  assert.deepEqual(rec.argv, ['list', '-s=pw-x'])
  assert.equal(rec.env.PLAYWRIGHT_MCP_HEADLESS, 'true')
})
