import chromium from './chromium.js'
import firefox from './firefox.js'

const ADAPTERS = { chromium, firefox }
export const names = Object.keys(ADAPTERS)

export function get (name) {
  const a = ADAPTERS[name]
  if (!a) throw new Error(`pw: unsupported browser '${name}'. Use one of: ${names.join(', ')}`)
  return a
}
