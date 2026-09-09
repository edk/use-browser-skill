import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { parsePs, parseWmi, listProcesses, isAlive, killPids } from '../../lib/procs.js'

test('parsePs handles paths with spaces', () => {
  const out = [
    ' 501 /Applications/My Browser.app/x --user-data-dir=/a b/prof',
    '  22 /bin/sh'
  ].join('\n')
  assert.deepEqual(parsePs(out), [
    { pid: 501, cmdline: '/Applications/My Browser.app/x --user-data-dir=/a b/prof' },
    { pid: 22, cmdline: '/bin/sh' }
  ])
})

test('parsePs skips malformed lines', () => {
  assert.deepEqual(parsePs('\n  \nnotapid stuff\n'), [])
})

test('parseWmi accepts a single object and an array and a null cmdline', () => {
  assert.deepEqual(parseWmi('{"ProcessId":4,"CommandLine":"chrome.exe --x"}'),
    [{ pid: 4, cmdline: 'chrome.exe --x' }])
  assert.deepEqual(parseWmi('[{"ProcessId":4,"CommandLine":null}]'),
    [{ pid: 4, cmdline: '' }])
})

test('listProcesses uses ps on posix and powershell on win32', async () => {
  const calls = []
  const exec = async (cmd, args) => { calls.push([cmd, args]); return '{"ProcessId":1,"CommandLine":"a"}' }
  await listProcesses({ platform: 'win32', exec })
  assert.match(calls[0][0], /powershell|pwsh/)
  assert.ok(calls[0][1].join(' ').includes('Win32_Process'))

  const calls2 = []
  const exec2 = async (cmd, args) => { calls2.push([cmd, args]); return ' 1 a' }
  await listProcesses({ platform: 'linux', exec: exec2 })
  assert.equal(calls2[0][0], 'ps')
  // -ww: without it ps truncates args to the terminal width, and a browser
  // command line is long enough that --user-data-dir falls off the end.
  assert.deepEqual(calls2[0][1], ['-axww', '-o', 'pid=,args='])
})

test('listProcesses returns empty on failure rather than throwing', async () => {
  const exec = async () => { throw new Error('nope') }
  assert.deepEqual(await listProcesses({ platform: 'linux', exec }), [])
})

test('isAlive is true for this process and false for an impossible pid', () => {
  assert.equal(isAlive(process.pid), true)
  assert.equal(isAlive(0x7ffffff0), false)
})

test('killPids kills a live child process', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: false })
  const pid = child.pid
  try {
    assert.equal(isAlive(pid), true, 'child should be alive before kill')
    await killPids([pid], { graceMs: 100 })

    // Poll for death with bounded timeout
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      if (!isAlive(pid)) break
      await new Promise(r => setTimeout(r, 50))
    }
    assert.equal(isAlive(pid), false, 'child should be dead after killPids')
  } catch (err) {
    try { process.kill(pid, 'SIGKILL') } catch {}
    throw err
  }
})

test('killPids does not throw on already-dead pid', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { detached: false })
  const pid = child.pid
  try {
    await new Promise(resolve => child.on('exit', resolve))
    assert.equal(isAlive(pid), false, 'child should be dead')
    await killPids([pid])
  } catch (err) {
    try { process.kill(pid, 'SIGKILL') } catch {}
    throw err
  }
})

test('killPids with empty list resolves immediately', async () => {
  const start = Date.now()
  await killPids([])
  const elapsed = Date.now() - start
  assert.ok(elapsed < 100, 'empty killPids should resolve immediately')
})

test('killPids on Windows skips the grace period', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: false })
  const pid = child.pid
  try {
    const sleepCalls = []
    const sleep = async (ms) => {
      sleepCalls.push(ms)
      await new Promise(r => setTimeout(r, ms))
    }
    await killPids([pid], { platform: 'win32', graceMs: 100, sleep })

    // Poll for death
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      if (!isAlive(pid)) break
      await new Promise(r => setTimeout(r, 50))
    }

    assert.equal(sleepCalls.length, 0, 'Windows path should not call sleep')
    assert.equal(isAlive(pid), false, 'process should still be dead')
  } catch (err) {
    try { process.kill(pid, 'SIGKILL') } catch {}
    throw err
  }
})
