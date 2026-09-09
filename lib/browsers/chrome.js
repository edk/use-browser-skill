import { createChromiumFamilyAdapter } from './chromium.js'

// Real, branded Google Chrome, not the Playwright-supplied Chrome for
// Testing build. Chromium-family under the hood — same profile layout, lock
// files, and cookie store as the chromium adapter — but launched via the
// engine's 'chrome' channel against the user's actual installed Chrome, which
// some sites' bot protection fingerprints differently than a patched
// Playwright build. Keeps its own golden profile: mixing it with chromium's
// would mix two different builds' profile formats.
//
// See macChromeWarning in chromium.js for the one documented cost of this
// choice on macOS.
export default createChromiumFamilyAdapter('chrome', 'chrome')
