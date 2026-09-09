#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const subdir = process.argv[2]
if (!subdir) {
  console.error('Usage: node test/run-tests.js <unit|integration>')
  process.exit(1)
}

const testDir = path.join('test', subdir)
let files
try {
  files = fs.readdirSync(testDir)
} catch {
  console.log(`test/${subdir} does not exist`)
  process.exit(0)
}

const testFiles = files
  .filter(f => f.endsWith('.test.js'))
  .sort()
  .map(f => path.join(testDir, f))

if (testFiles.length === 0) {
  console.log(`no test files found in test/${subdir}`)
  process.exit(0)
}

const proc = spawn(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' })
// A child killed by a signal reports a null exit code. Passing that straight
// through exits 0, which reports a crashed run as a green one.
proc.on('exit', (code, signal) => {
  if (code === null) {
    console.error(`test runner terminated by signal ${signal}`)
    process.exit(1)
  }
  process.exit(code)
})
