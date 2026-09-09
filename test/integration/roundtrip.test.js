import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SKIP, startServer, pwx, mkroot, listRow } from './helpers.js'
import { get } from '../../lib/browsers/index.js'
import { profileBrowserPids } from '../../lib/session.js'

for (const browser of ['chromium', 'firefox']) {
  test(`${browser}: promote carries a cookie into a new session`, { skip: SKIP }, async () => {
    const srv = await startServer()
    const root = mkroot()
    try {
      await pwx(['open', `${srv.url}/set`], { root, sessionId: 'aaa', browser })
      await pwx(['end'], { root, sessionId: 'aaa', browser })
      const p = await pwx(['promote'], { root, sessionId: 'aaa', browser })
      assert.equal(p.code, 0, p.stderr)
      assert.equal(fs.existsSync(path.join(root, 'golden', browser)), true)

      await pwx(['open', `${srv.url}/read`], { root, sessionId: 'bbb', browser })
      const r = await pwx(['--raw', 'eval', 'document.getElementById("r").textContent'],
        { root, sessionId: 'bbb', browser })
      assert.match(r.stdout, /pwx=1/)
    } finally {
      await pwx(['end'], { root, sessionId: 'bbb', browser })
      srv.close()
    }
  })

  test(`${browser}: two sessions do not share cookies`, { skip: SKIP }, async () => {
    const srv = await startServer()
    const root = mkroot()
    try {
      await pwx(['open', `${srv.url}/set`], { root, sessionId: 'one', browser })
      await pwx(['open', `${srv.url}/read`], { root, sessionId: 'two', browser })
      const r = await pwx(['--raw', 'eval', 'document.getElementById("r").textContent'],
        { root, sessionId: 'two', browser })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /none/)
      assert.doesNotMatch(r.stdout, /pwx=1/)
    } finally {
      await pwx(['end'], { root, sessionId: 'one', browser })
      await pwx(['end'], { root, sessionId: 'two', browser })
      srv.close()
    }
  })

  test(`${browser}: open reaps an orphan holding the profile`, { skip: SKIP }, async () => {
    const srv = await startServer()
    const root = mkroot()
    try {
      await pwx(['open', `${srv.url}/set`], { root, sessionId: 'orp', browser })
      // Kill the daemon but leave the browser: the exact state that used to
      // fail the next launch with "Browser is already in use".
      await pwx(['kill-all'], { root, sessionId: 'orp', browser })
      const r = await pwx(['open', `${srv.url}/read`], { root, sessionId: 'orp', browser })
      assert.equal(r.code, 0, r.stderr)
    } finally {
      await pwx(['end'], { root, sessionId: 'orp', browser })
      srv.close()
    }
  })

  // Deliberately runs with NO PLAYWRIGHT_MCP_HEADLESS. That variable beats the
  // mode file in config resolution, so the earlier version of this case passed
  // whether or not `hide` did anything at all: it was the only coverage of the
  // mode file and of clearing the daemon's cached launch options against the
  // real daemon, and it asserted nothing. Without the override the mode file is
  // the only thing that can make this launch headless.
  test(`${browser}: hide makes the next open headless through the mode file alone`, { skip: SKIP }, async () => {
    const srv = await startServer()
    const root = mkroot()
    const opts = { root, sessionId: 'mod', browser, headless: null }
    try {
      const h = await pwx(['hide'], opts)
      assert.equal(h.code, 0, h.stderr)
      assert.equal(fs.readFileSync(path.join(root, 'sessions', 'mod', 'mode'), 'utf8').trim(), 'headless')

      const o = await pwx(['open', `${srv.url}/read`], opts)
      assert.equal(o.code, 0, o.stderr)
      const row = await listRow('pw-mod', opts)
      assert.ok(row, 'pw-mod should be listed after open')
      assert.equal(row.status, 'open')
      assert.equal(row.headed, false, 'the mode file, not the environment, must have decided this')
    } finally {
      await pwx(['end'], opts)
      srv.close()
    }
  })

  // The coverage gap that let the session-state defect ship. Nothing exercised
  // a second open against a session that was genuinely live, so a parser that
  // read every live session as closed passed the whole suite while `open URL`
  // reaped its own browser and relaunched, losing any login it was holding.
  test(`${browser}: a second open on a live session navigates, it does not relaunch`, { skip: SKIP }, async () => {
    const srv = await startServer()
    const root = mkroot()
    const opts = { root, sessionId: 'nav', browser }
    const profile = path.join(root, 'sessions', 'nav', 'profile')
    const adapter = get(browser)
    try {
      const first = await pwx(['open', `${srv.url}/one`], opts)
      assert.equal(first.code, 0, first.stderr)
      const before = await profileBrowserPids(adapter, profile)
      assert.ok(before.length > 0, 'expected a browser process holding the session profile')
      assert.equal((await listRow('pw-nav', opts))?.status, 'open')

      const second = await pwx(['open', `${srv.url}/two`], opts)
      assert.equal(second.code, 0, second.stderr)
      // The reap-and-relaunch path announces itself on stderr; navigating does not.
      assert.doesNotMatch(second.stderr, /reaping the orphaned browser/)
      assert.doesNotMatch(second.stderr, /seeded this session's profile/)

      const after = await profileBrowserPids(adapter, profile)
      for (const pid of before) {
        assert.ok(after.includes(pid), `browser pid ${pid} was killed: the second open relaunched instead of navigating`)
      }

      const page = await pwx(['--raw', 'eval', 'location.href'], opts)
      assert.match(page.stdout, /\/two/, 'the live browser should have navigated to the second url')
    } finally {
      await pwx(['end'], opts)
      srv.close()
    }
  })
}
