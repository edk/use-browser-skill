import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { get, names } from '../../lib/browsers/index.js'
import { macChromeWarning } from '../../lib/browsers/chromium.js'
import { BROWSERS } from '../../lib/config.js'

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-b-'))

test('registry exposes all four browsers and rejects others', () => {
  assert.deepEqual(names, ['chromium', 'chrome', 'msedge', 'firefox'])
  assert.throws(() => get('webkit'), /unsupported browser/)
})

test('config BROWSERS matches the registry, in the same order', () => {
  assert.deepEqual(BROWSERS, names)
})

test('chrome and msedge are Chromium-family: same lock files, prune list, cookie and argv logic as chromium', () => {
  const chromium = get('chromium')
  const chrome = get('chrome')
  const msedge = get('msedge')
  for (const other of [chrome, msedge]) {
    assert.deepEqual(other.lockFiles, chromium.lockFiles)
    assert.deepEqual(other.pruneDirs, chromium.pruneDirs)
    assert.equal(other.unsafeUrl('https://d.test/x/export?format=csv'), chromium.unsafeUrl('https://d.test/x/export?format=csv'))
  }
})

test('each Chromium-family adapter carries its own name and cliBrowser', () => {
  assert.equal(get('chromium').name, 'chromium')
  assert.equal(get('chromium').cliBrowser, 'chromium')
  assert.equal(get('chrome').name, 'chrome')
  assert.equal(get('chrome').cliBrowser, 'chrome')
  assert.equal(get('msedge').name, 'msedge')
  assert.equal(get('msedge').cliBrowser, 'msedge')
})

test('chrome and msedge share chromium argvMatches/beforeLaunch/cookieCount behaviour', async () => {
  for (const name of ['chrome', 'msedge']) {
    const adapter = get(name)
    const dir = '/a b/prof'
    assert.equal(adapter.argvMatches(`chrome --user-data-dir=${dir} --x`, dir, 'linux'), true)
    assert.equal(adapter.argvMatches(`chrome --user-data-dir=${dir}-2`, dir, 'linux'), false)

    const profileDir = mk()
    const prefs = path.join(profileDir, 'Default', 'Preferences')
    fs.mkdirSync(path.dirname(prefs), { recursive: true })
    fs.writeFileSync(prefs, JSON.stringify({ profile: { exit_type: 'Crashed', exited_cleanly: false } }))
    await adapter.beforeLaunch(profileDir)
    const after = JSON.parse(fs.readFileSync(prefs, 'utf8'))
    assert.equal(after.profile.exit_type, 'Normal')

    assert.equal(await adapter.cookieCount(mk()), null)
  }
})

test('macChromeWarning: only chrome, only darwin', () => {
  assert.match(macChromeWarning('chrome', 'darwin'), /replayd/)
  assert.equal(macChromeWarning('chromium', 'darwin'), null)
  assert.equal(macChromeWarning('msedge', 'darwin'), null)
  assert.equal(macChromeWarning('chrome', 'linux'), null)
  assert.equal(macChromeWarning('chrome', 'win32'), null)
})

test('chromium argvMatches is exact, space tolerant, and rejects prefixes', () => {
  const c = get('chromium')
  const dir = '/a b/prof'
  assert.equal(c.argvMatches(`chrome --user-data-dir=${dir} --x`, dir, 'linux'), true)
  assert.equal(c.argvMatches(`chrome --user-data-dir=${dir}`, dir, 'linux'), true)
  assert.equal(c.argvMatches(`chrome --user-data-dir=${dir}-2`, dir, 'linux'), false)
  assert.equal(c.argvMatches('chrome --user-data-dir=/other', dir, 'linux'), false)
})

test('firefox argvMatches handles -profile and --profile', () => {
  const f = get('firefox')
  const dir = '/a b/prof'
  assert.equal(f.argvMatches(`firefox -profile ${dir} -foreground`, dir, 'linux'), true)
  assert.equal(f.argvMatches(`firefox --profile ${dir}`, dir, 'linux'), true)
  assert.equal(f.argvMatches(`firefox -profile ${dir}-2`, dir, 'linux'), false)
})

test('argvMatches folds case on win32 only', () => {
  const c = get('chromium')
  const dir = 'C:\\Users\\U\\prof'
  assert.equal(c.argvMatches('chrome.exe --user-data-dir=c:\\users\\u\\prof', dir, 'win32'), true)
  assert.equal(c.argvMatches('chrome --user-data-dir=/A', '/a', 'linux'), false)
})

// Win32_Process reports the literal command line and libuv quotes any argument
// containing a space, so every Windows account name with a space in it — which
// is the common case — produced a command line none of these matchers could
// see. Orphans were never reaped and promote never refused on a live browser.
test('argvMatches sees a quoted Windows command line for a profile path with a space', () => {
  const c = get('chromium')
  const f = get('firefox')
  const dir = 'C:\\Users\\Ed Kim\\.cache\\pwx\\sessions\\ab12\\profile'

  // libuv quotes the whole token, flag included.
  assert.equal(c.argvMatches(`"C:\\pw\\chrome.exe" "--user-data-dir=${dir}" --no-first-run`, dir, 'win32'), true)
  // Other launchers quote only the value.
  assert.equal(c.argvMatches(`chrome.exe --user-data-dir="${dir}" --no-first-run`, dir, 'win32'), true)
  // Firefox's two-token form: the quote falls between the flag and the path.
  assert.equal(f.argvMatches(`"C:\\pw\\firefox.exe" -profile "${dir}" -foreground`, dir, 'win32'), true)
  assert.equal(f.argvMatches(`firefox.exe --profile "${dir}"`, dir, 'win32'), true)
  // Unquoted still matches (a path with no space is not quoted at all).
  const plain = 'C:\\pwx\\sessions\\ab12\\profile'
  assert.equal(c.argvMatches(`chrome.exe --user-data-dir=${plain} --x`, plain, 'win32'), true)
  assert.equal(f.argvMatches(`firefox.exe -profile ${plain} -x`, plain, 'win32'), true)
})

test('argvMatches still rejects a neighbouring profile when the Windows path is quoted', () => {
  const c = get('chromium')
  const f = get('firefox')
  const dir = 'C:\\Users\\Ed Kim\\.cache\\pwx\\sessions\\ab12\\profile'
  assert.equal(c.argvMatches(`chrome.exe "--user-data-dir=${dir}-2"`, dir, 'win32'), false)
  assert.equal(c.argvMatches(`chrome.exe --user-data-dir="${dir}-2"`, dir, 'win32'), false)
  assert.equal(f.argvMatches(`firefox.exe -profile "${dir}-2"`, dir, 'win32'), false)
  assert.equal(f.argvMatches(`firefox.exe -profile "C:\\Users\\Ed Kim\\elsewhere"`, dir, 'win32'), false)
})

test('a quote is not a terminator off Windows, where it is an ordinary path character', () => {
  const c = get('chromium')
  const dir = '/home/u/pro'
  assert.equal(c.argvMatches(`chrome --user-data-dir=${dir}"file`, dir, 'linux'), false)
})

test('chromium beforeLaunch marks the previous exit clean', async () => {
  const dir = mk()
  const prefs = path.join(dir, 'Default', 'Preferences')
  fs.mkdirSync(path.dirname(prefs), { recursive: true })
  fs.writeFileSync(prefs, JSON.stringify({ profile: { exit_type: 'Crashed', exited_cleanly: false }, keep: 1 }))
  await get('chromium').beforeLaunch(dir)
  const after = JSON.parse(fs.readFileSync(prefs, 'utf8'))
  assert.equal(after.profile.exit_type, 'Normal')
  assert.equal(after.profile.exited_cleanly, true)
  assert.equal(after.keep, 1)
})

test('chromium beforeLaunch tolerates a missing or corrupt Preferences file', async () => {
  const dir = mk()
  await get('chromium').beforeLaunch(dir)
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), 'not json')
  await get('chromium').beforeLaunch(dir)
})

test('firefox beforeLaunch writes the prefs that suppress restore and default-browser prompts', async () => {
  const dir = mk()
  await get('firefox').beforeLaunch(dir)
  const js = fs.readFileSync(path.join(dir, 'user.js'), 'utf8')
  assert.match(js, /browser\.sessionstore\.resume_from_crash", false/)
  assert.match(js, /browser\.shell\.checkDefaultBrowser", false/)
  await get('firefox').beforeLaunch(dir)
  const twice = fs.readFileSync(path.join(dir, 'user.js'), 'utf8')
  assert.equal(twice.match(/resume_from_crash/g).length, 1)
})

test('cookieCount returns null when the cookie store is absent', async () => {
  const dir = mk()
  assert.equal(await get('chromium').cookieCount(dir), null)
  assert.equal(await get('firefox').cookieCount(dir), null)
})

test('cookieCount returns could-not-tell, not a rejection, when the temp dir is unusable', async () => {
  // promote awaits this after the install has already succeeded, so a throw
  // here reported a stack trace for a promote that actually worked.
  const dir = mk()
  const cookies = path.join(dir, 'Default', 'Cookies')
  fs.mkdirSync(path.dirname(cookies), { recursive: true })
  fs.writeFileSync(cookies, 'not a sqlite database')
  const saved = process.env.TMPDIR
  process.env.TMPDIR = path.join(dir, 'no', 'such', 'directory')
  try {
    assert.equal(await get('chromium').cookieCount(dir), null)
  } finally {
    if (saved === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = saved
  }
})

test('unsafeUrl only blocks export downloads and only on chromium', () => {
  const u = 'https://docs.google.com/spreadsheets/d/x/export?format=csv'
  assert.equal(get('chromium').unsafeUrl(u), true)
  assert.equal(get('chromium').unsafeUrl('https://example.com/'), false)
  assert.equal(get('firefox').unsafeUrl(u), false)
})

test('installArgs adds --with-deps on linux only', () => {
  assert.deepEqual(get('firefox').installArgs('linux'), ['install-browser', 'firefox', '--with-deps'])
  assert.deepEqual(get('firefox').installArgs('darwin'), ['install-browser', 'firefox'])
})
