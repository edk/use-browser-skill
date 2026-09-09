import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tokenPath, resolveExtensionToken, writeExtensionToken, clearExtensionToken } from '../../lib/token.js'

const mkroot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-token-'))
const ctxFor = root => ({ stateRoot: root })

test('tokenPath lives under stateRoot directly, not any per-agent session directory', () => {
  const root = mkroot()
  assert.equal(tokenPath(ctxFor(root)), path.join(root, 'extension-token'))
})

test('resolveExtensionToken: environment wins outright, without even looking at the file', () => {
  const root = mkroot()
  // A file that would be REFUSED if read (world-readable) must never even be
  // statted when the environment already answers the question — proves env
  // truly short-circuits rather than merely being preferred after a check.
  fs.writeFileSync(tokenPath(ctxFor(root)), 'file-token\n', { mode: 0o644 })
  const r = resolveExtensionToken(ctxFor(root), { PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'env-token' })
  assert.equal(r.token, 'env-token')
  assert.equal(r.source, 'env')
  assert.equal(r.error, null)
})

test('resolveExtensionToken: falls back to the file when the environment is unset', () => {
  const root = mkroot()
  const file = tokenPath(ctxFor(root))
  fs.writeFileSync(file, 'file-token\n', { mode: 0o600 })
  const r = resolveExtensionToken(ctxFor(root), {})
  assert.equal(r.token, 'file-token')
  assert.equal(r.source, 'file')
  assert.equal(r.error, null)
})

test('resolveExtensionToken: no env and no file is "not configured", not an error', () => {
  const root = mkroot()
  const r = resolveExtensionToken(ctxFor(root), {})
  assert.equal(r.token, null)
  assert.equal(r.source, null)
  assert.equal(r.error, null)
})

test('resolveExtensionToken: a token file with group/other-readable permissions is refused, not read', () => {
  const root = mkroot()
  const file = tokenPath(ctxFor(root))
  fs.writeFileSync(file, 'file-token\n', { mode: 0o644 })
  const r = resolveExtensionToken(ctxFor(root), {})
  assert.equal(r.token, null)
  assert.equal(r.source, null)
  assert.ok(r.error, 'expected an error describing the bad permissions')
  assert.equal(r.error.path, file)
  assert.equal(r.error.mode, 0o644)
})

test('resolveExtensionToken: an empty token file resolves as not configured', () => {
  const root = mkroot()
  fs.writeFileSync(tokenPath(ctxFor(root)), '', { mode: 0o600 })
  const r = resolveExtensionToken(ctxFor(root), {})
  assert.equal(r.token, null)
  assert.equal(r.source, null)
})

test('writeExtensionToken creates the file owner-only and trims back out cleanly', () => {
  const root = mkroot()
  const file = writeExtensionToken(ctxFor(root), 'brand-new-token', 'linux')
  assert.equal(file, tokenPath(ctxFor(root)))
  const mode = fs.statSync(file).mode & 0o777
  assert.equal(mode, 0o600)
  const r = resolveExtensionToken(ctxFor(root), {})
  assert.equal(r.token, 'brand-new-token')
  assert.equal(r.source, 'file')
})

test('writeExtensionToken tightens permissions on overwrite, even if the existing file was looser', () => {
  const root = mkroot()
  const file = tokenPath(ctxFor(root))
  fs.writeFileSync(file, 'old-token\n', { mode: 0o644 })
  writeExtensionToken(ctxFor(root), 'new-token', 'linux')
  const mode = fs.statSync(file).mode & 0o777
  assert.equal(mode, 0o600)
  const r = resolveExtensionToken(ctxFor(root), {})
  assert.equal(r.token, 'new-token')
})

test('writeExtensionToken creates stateRoot if it does not exist yet', () => {
  const root = path.join(mkroot(), 'nested', 'deeper')
  const file = writeExtensionToken(ctxFor(root), 'tok', 'linux')
  assert.ok(fs.existsSync(file))
})

test('clearExtensionToken removes the file and reports whether one existed', () => {
  const root = mkroot()
  const file = tokenPath(ctxFor(root))
  fs.writeFileSync(file, 'tok\n', { mode: 0o600 })
  assert.equal(clearExtensionToken(ctxFor(root)), true)
  assert.equal(fs.existsSync(file), false)
  assert.equal(clearExtensionToken(ctxFor(root)), false, 'a second clear with nothing there is a no-op that says so')
})
