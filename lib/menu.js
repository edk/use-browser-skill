import readline from 'node:readline'

// Kept in sync with the verb list in bin/pwx.js printHelp. Each entry names the
// argv it produces and any extra input to ask for.
export const ITEMS = [
  { label: 'open a URL', argv: ['open'], prompt: 'URL' },
  { label: 'open a URL in Firefox', argv: ['open', '--browser', 'firefox'], prompt: 'URL' },
  { label: 'show (make the browser visible)', argv: ['show'] },
  { label: 'hide (background, headless)', argv: ['hide'] },
  { label: 'status', argv: ['status'] },
  { label: 'snapshot the current page', argv: ['snapshot'] },
  { label: 'screenshot', argv: ['screenshot'] },
  { label: 'gc (reap orphans and stale profiles)', argv: ['gc'] },
  { label: 'promote (save logins for future sessions)', argv: ['promote'] },
  { label: 'attach to your real, already-running browser (via extension)', argv: ['attach'] },
  { label: 'end (close the browser, keep logins; detaches if attached)', argv: ['end'] },
  { label: 'forget (clear this session login)', argv: ['forget'] },
  // No `prompt` here: the secret itself comes from stdin once this argv is
  // exec'd with inherited stdio (see the 'menu' case in bin/pwx.js), not
  // from this menu's own line-based, echoing ask() prompt.
  { label: 'set the extension approval token (paste via stdin, hidden)', argv: ['token', 'set'] },
  { label: 'config', argv: ['config'] }
]

export async function runMenu (ctx, { input = process.stdin, output = process.stdout } = {}) {
  // Deliberately not rl.question(): with a finite input stream (as in tests)
  // the stream's 'end' fires and auto-closes the interface before a second
  // question can be asked, throwing ERR_USE_AFTER_CLOSE. The async-iterator
  // form pulls one line at a time and isn't subject to that race.
  const rl = readline.createInterface({ input, output })
  const lines = rl[Symbol.asyncIterator]()
  const ask = async q => {
    output.write(q)
    const { value, done } = await lines.next()
    return done ? '' : value
  }
  try {
    for (;;) {
      output.write(`\npwx — session ${ctx.session}, browser ${ctx.browser}\n`)
      ITEMS.forEach((it, i) => output.write(`  ${i + 1}) ${it.label}\n`))
      output.write('  q) quit\n')
      const pick = (await ask('choice: ')).trim()
      if (pick === 'q' || pick === '') return []
      const idx = Number(pick) - 1
      if (!Number.isInteger(idx) || idx < 0 || idx >= ITEMS.length) {
        output.write(`  '${pick}' is not a choice\n`)
        continue
      }
      const item = ITEMS[idx]
      const argv = [...item.argv]
      if (item.prompt) {
        const val = (await ask(`${item.prompt}: `)).trim()
        if (val) argv.push(val)
      }
      return argv
    }
  } finally {
    rl.close()
  }
}
