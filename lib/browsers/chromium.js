import fs from 'node:fs'
import path from 'node:path'

// Decide whether a command line launched a browser on exactly this profile.
// This function decides what gets killed, so a plain substring test will not
// do: it also matches "<dir>-2", i.e. a DIFFERENT session's profile. The path
// itself may contain spaces, so the match is a substring anchored by what
// follows it: end of line, or a separator.
//
// Windows command lines are quoted, and that is the whole reason `needles` is
// a (flag, value) pair rather than one string. Win32_Process reports the
// literal command line, and libuv quotes any argument containing a space, so a
// profile under C:\Users\Ed Kim\... appears as
//
//   "--user-data-dir=C:\Users\Ed Kim\...\profile"      (whole token quoted)
//   -profile "C:\Users\Ed Kim\...\profile"             (value quoted)
//
// and other launchers produce --user-data-dir="C:\Users\Ed Kim\...". None of
// those contain a bare flag-then-path run terminated by a space. Left
// unhandled, no Windows user whose account name has a space ever had an
// orphaned browser reaped, and promote's live-browser refusal never fired for
// them. So on Windows each needle also gets a form with the quote sitting
// between the flag and the path, and a quote counts as a terminator.
export function matchFlag (cmdline, needles, platform) {
  const win = platform === 'win32'
  const hay = win ? cmdline.toLowerCase() : cmdline
  const terminators = win ? [' ', '"'] : [' ']
  for (const [rawFlag, rawValue] of needles) {
    const flag = win ? rawFlag.toLowerCase() : rawFlag
    const value = win ? rawValue.toLowerCase() : rawValue
    const forms = win ? [flag + value, `${flag}"${value}`] : [flag + value]
    for (const needle of forms) {
      let from = 0
      for (;;) {
        const i = hay.indexOf(needle, from)
        if (i < 0) break
        const next = hay[i + needle.length]
        if (next === undefined || terminators.includes(next)) return true
        from = i + 1
      }
    }
  }
  return false
}

export function variants (dir) {
  const out = new Set([dir, path.normalize(dir)])
  try { out.add(fs.realpathSync(dir)) } catch {}
  return [...out]
}

// 'chromium', 'chrome', and 'msedge' are all Chromium under the hood, so their
// on-disk profile layout, lock files, cache directories, Preferences file,
// cookie store location, and command-line flag shape are identical. Only the
// adapter's own `name` and the `cliBrowser` value handed to the engine differ
// between the three, so every other Chromium-family adapter is this same
// object with those two fields swapped in — never a second copy of the logic
// below.
export function createChromiumFamilyAdapter (name, cliBrowser) {
  return {
    name,
    cliBrowser,
    lockFiles: ['SingletonLock', 'SingletonSocket', 'SingletonCookie'],
    pruneDirs: [
      'Default/Cache', 'Default/Code Cache', 'Default/Service Worker',
      'Default/GPUCache', 'Default/DawnWebGPUCache', 'Default/DawnGraphiteCache',
      'Default/Shared Dictionary', 'Default/Sessions', 'Default/History',
      'GraphiteDawnCache', 'GPUPersistentCache', 'component_crx_cache'
    ],
    installArgs (platform) {
      const a = ['install-browser', name]
      if (platform === 'linux') a.push('--with-deps')
      return a
    },
    // Playwright kills Chrome before it writes its clean-exit marker, so every
    // relaunch shows "Restore pages?". Cosmetic only; logins are flushed by the
    // CDP close regardless.
    async beforeLaunch (profileDir) {
      const prefs = path.join(profileDir, 'Default', 'Preferences')
      let data
      try { data = JSON.parse(await fs.promises.readFile(prefs, 'utf8')) } catch { return }
      data.profile = data.profile || {}
      data.profile.exit_type = 'Normal'
      data.profile.exited_cleanly = true
      const tmp = `${prefs}.pwx-tmp`
      await fs.promises.writeFile(tmp, JSON.stringify(data))
      await fs.promises.rename(tmp, prefs)
    },
    async cookieCount (profileDir) {
      return countRows(path.join(profileDir, 'Default', 'Cookies'), 'cookies')
    },
    argvMatches (cmdline, profileDir, platform = process.platform) {
      return matchFlag(cmdline, variants(profileDir).map(d => ['--user-data-dir=', d]), platform)
    },
    // These URLs crash the IPC stream mid-launch: Chrome starts and takes the
    // Singleton lock, the Node stream dies before the session registers, and
    // Chrome is left orphaned holding the profile.
    unsafeUrl (url) {
      return /\/export\?format=/.test(url)
    }
  }
}

export default createChromiumFamilyAdapter(
  'chromium',
  // Chrome for Testing, not branded Chrome: two branded instances drive macOS
  // replayd into a 100-300% CPU spin (crbug.com/379347944). Selecting the
  // 'chrome' adapter (lib/browsers/chrome.js) opts back into that risk
  // deliberately, for sites that fingerprint the Playwright-patched build; see
  // macChromeWarning below.
  'chromium'
)

// One-line, macOS-only warning for the one documented cost of choosing real
// Chrome over the default chromium channel: crbug.com/379347944 above. Kept
// as a plain function, not adapter state, so bin/pwx.js can call it once per
// launch without the adapter objects needing to know about warning output.
export function macChromeWarning (adapterName, platform) {
  if (platform !== 'darwin' || adapterName !== 'chrome') return null
  return "using real Chrome: if your everyday Chrome is also open, macOS's replayd process can spike to 100-300% CPU (crbug.com/379347944) — the default 'chromium' channel avoids this."
}

// node:sqlite landed in Node 22. On Node 20 we cannot read the store, so
// return null ("could not tell") rather than 0, which callers would report as
// "your promoted profile has no logins".
export async function countRows (file, table) {
  if (!fs.existsSync(file)) return null
  let DatabaseSync
  try { ({ DatabaseSync } = await import('node:sqlite')) } catch { return null }
  const os = await import('node:os')
  // mkdtemp belongs INSIDE the try: an unwritable temp dir used to reject out
  // of here, and promote awaits this only after the install already succeeded,
  // so the user got a stack trace for a promote that had in fact worked.
  let dir = null
  try {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pwx-ck-'))
    const tmp = path.join(dir, 'db')
    await fs.promises.copyFile(file, tmp)
    const db = new DatabaseSync(tmp, { readOnly: true })
    const row = db.prepare(`select count(*) as n from ${table}`).get()
    db.close()
    return Number(row.n)
  } catch {
    return null
  } finally {
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
