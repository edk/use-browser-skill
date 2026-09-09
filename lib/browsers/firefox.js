import fs from 'node:fs'
import path from 'node:path'
import { matchFlag, variants, countRows } from './chromium.js'

const USER_JS = [
  'user_pref("browser.sessionstore.resume_from_crash", false);',
  'user_pref("browser.shell.checkDefaultBrowser", false);'
]

export default {
  name: 'firefox',
  cliBrowser: 'firefox',
  lockFiles: ['.parentlock', 'lock', 'parent.lock'],
  pruneDirs: [
    'cache2', 'startupCache', 'shader-cache', 'thumbnails',
    'sessionstore-backups', 'crashes', 'minidumps', 'storage/default/*/cache'
  ],
  installArgs (platform) {
    const a = ['install-browser', 'firefox']
    if (platform === 'linux') a.push('--with-deps')
    return a
  },
  // Firefox has no Preferences JSON. user.js is re-applied at every startup and
  // overrides prefs.js, which is what we want after a profile copy.
  async beforeLaunch (profileDir) {
    await fs.promises.mkdir(profileDir, { recursive: true })
    const file = path.join(profileDir, 'user.js')
    let current = ''
    try { current = await fs.promises.readFile(file, 'utf8') } catch {}
    const missing = USER_JS.filter(line => !current.includes(line))
    if (missing.length) {
      await fs.promises.appendFile(file, (current && !current.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n')
    }
  },
  async cookieCount (profileDir) {
    return countRows(path.join(profileDir, 'cookies.sqlite'), 'moz_cookies')
  },
  argvMatches (cmdline, profileDir, platform = process.platform) {
    const needles = []
    for (const d of variants(profileDir)) { needles.push(['-profile ', d], ['--profile ', d]) }
    return matchFlag(cmdline, needles, platform)
  },
  unsafeUrl () { return false }
}
