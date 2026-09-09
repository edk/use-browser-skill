import { createChromiumFamilyAdapter } from './chromium.js'

// Real, installed Microsoft Edge. Chromium-family under the hood — same
// profile layout, lock files, and cookie store as the chromium adapter — but
// launched via the engine's 'msedge' channel. Keeps its own golden profile,
// separate from chromium's and chrome's.
export default createChromiumFamilyAdapter('msedge', 'msedge')
