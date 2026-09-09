import { execFile } from 'node:child_process'

// -ww, not -w: ps truncates args to the terminal width by default, and a
// single -w only widens it. A browser command line runs to several hundred
// characters, and --user-data-dir is not near the front, so a truncated line
// means an orphan is never matched and never reaped. Both BSD (macOS) and
// procps (Linux) read the doubled flag as "no limit".
const PS_ARGS = ['-axww', '-o', 'pid=,args=']
const WMI_SCRIPT =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'

function defaultExec (cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout)
    })
  })
}

export function parsePs (text) {
  const out = []
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (m && m[2].length) out.push({ pid: Number(m[1]), cmdline: m[2] })
  }
  return out
}

export function parseWmi (json) {
  let data
  try { data = JSON.parse(json) } catch { return [] }
  if (!data) return []
  const rows = Array.isArray(data) ? data : [data]
  return rows
    .filter(r => r && Number.isFinite(Number(r.ProcessId)))
    .map(r => ({ pid: Number(r.ProcessId), cmdline: r.CommandLine ?? '' }))
}

// WMIC is removed on current Windows 10 builds, so the Windows path goes
// through CIM. Both branches swallow failures: an unreadable process table
// must read as "no matches", never as a crash mid-verb.
export async function listProcesses ({ platform = process.platform, exec = defaultExec } = {}) {
  try {
    if (platform === 'win32') {
      return parseWmi(await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WMI_SCRIPT]))
    }
    return parsePs(await exec('ps', PS_ARGS))
  } catch {
    return []
  }
}

export function isAlive (pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

const wait = ms => new Promise(r => setTimeout(r, ms))

// SIGTERM first so Chromium flushes its cookie DB (it batches writes on a ~30s
// timer; SIGKILL loses a login completed moments ago). Windows maps both
// signals to TerminateProcess, so the grace period buys nothing there.
export async function killPids (pids, { platform = process.platform, graceMs = 5000, sleep = wait } = {}) {
  if (!pids.length) return
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch {} }
  if (platform !== 'win32') {
    const deadline = Date.now() + graceMs
    while (Date.now() < deadline) {
      if (!pids.some(isAlive)) return
      await sleep(200)
    }
  }
  for (const pid of pids) { if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} } }
}
