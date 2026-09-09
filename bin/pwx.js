#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolve as resolveCtx, configPath, BROWSERS } from '../lib/config.js'
import { get as getAdapter } from '../lib/browsers/index.js'
import * as engine from '../lib/engine.js'
import * as session from '../lib/session.js'
import { runMenu } from '../lib/menu.js'

const PASSTHROUGH_NO_SESSION = new Set(['list', 'close-all', 'kill-all', 'install', '--version', '-V'])
const WRAPPER_VERBS = new Set([
  'help', '-h', '--help', 'open', 'fresh', 'end', 'show', 'hide', 'status',
  'gc', 'promote', 'forget', 'logout', 'nuke', 'selftest', 'config', 'menu'
])
const READ_ONLY = new Set(['help', '-h', '--help', 'status', 'gc', 'list', 'selftest', 'config', '--version', '-V'])

export function die (msg) {
  process.stderr.write(`pw: ${msg}\n`)
  process.exit(2)
}
const say = msg => process.stdout.write(`pw: ${msg}\n`)
const warn = msg => process.stderr.write(`pw: ${msg}\n`)

// --browser is ours, not playwright-cli's, so pull it out before anything else
// sees the argv.
export function extractBrowser (argv) {
  const out = []
  let browser = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--browser' && argv[i + 1]) { browser = argv[++i]; continue }
    if (argv[i].startsWith('--browser=')) { browser = argv[i].slice('--browser='.length); continue }
    out.push(argv[i])
  }
  return { argv: out, browser }
}

async function launchArgs (ctx, adapter) {
  if (ctx.ephemeral) return []
  const seeded = await session.seedFromGolden(ctx, adapter)
  if (seeded === 'seeded') warn(`seeded this session's profile from ${ctx.goldenDir} (saved logins carried over).`)
  if (seeded === 'failed') warn(`could not seed from ${ctx.goldenDir} — starting logged out.`)
  session.mkdirPrivate(ctx.profileDir, ctx.platform)
  await adapter.beforeLaunch(ctx.profileDir)
  return ['--persistent', '--profile', ctx.profileDir]
}

async function doLaunch (ctx, adapter, urls) {
  const args = await launchArgs(ctx, adapter)
  const cleared = await engine.clearSessionCache(ctx)
  if (cleared.dirMissing) {
    warn(`playwright daemon dir not found at ${ctx.daemonDir}; a headed/headless switch may not take effect.`)
  }
  if (cleared.skipped > 0) {
    warn(`could not read ${cleared.skipped} cached launch-option record(s) under ${ctx.daemonDir}; a headed/headless switch may not take effect.`)
  }
  session.recordBrowser(ctx)
  const openArgs = ['open', '--browser', adapter.cliBrowser, ...args]
  // A freshly seeded session with a pending snapshot must not navigate to the
  // caller's URL in the same call that launches the browser: state-load has
  // to land before the first page load, or the page renders from whatever
  // the disk-only profile had and the snapshot arrives too late to matter.
  // Every other launch — the overwhelming majority — keeps the original
  // single combined open+navigate call, unchanged.
  const hasPending = fs.existsSync(session.statePendingPath(ctx))
  if (!hasPending) {
    const r = await engine.run(ctx, [...openArgs, ...urls])
    if (r.code !== 0) {
      await session.killProfileBrowsers(ctx, adapter)
      die('open failed — profile browsers killed, lock cleared. Re-run pwx open.')
    }
    return
  }
  const r = await engine.run(ctx, openArgs)
  if (r.code !== 0) {
    await session.killProfileBrowsers(ctx, adapter)
    die('open failed — profile browsers killed, lock cleared. Re-run pwx open.')
  }
  const applied = await session.applyPendingState(ctx, engine.run)
  if (applied === 'failed') warn('could not apply the carried-over login state — starting logged out.')
  if (urls.length) {
    const g = await engine.run(ctx, ['goto', ...urls])
    if (g.code !== 0) {
      await session.killProfileBrowsers(ctx, adapter)
      die('goto failed — profile browsers killed, lock cleared. Re-run pwx open.')
    }
  }
}

async function main () {
  const raw = process.argv.slice(2).filter(a => a !== '--persistent')
  const { argv, browser: flagBrowser } = extractBrowser(raw)
  const bareInvocation = process.argv.length === 2
  const cmd = argv[0] ?? (bareInvocation && process.stdin.isTTY ? 'menu' : 'help')
  const rest = argv.slice(1)

  let ctx
  try {
    ctx = resolveCtx({ argvBrowser: flagBrowser })
  } catch (e) {
    die(e.message.replace(/^pw: /, ''))
  }
  const adapter = getAdapter(ctx.browser)

  const recorded = (() => {
    try { return fs.readFileSync(path.join(ctx.stateDir, 'browser'), 'utf8').trim() } catch { return '' }
  })()
  // A session directory recorded under one browser holds a profile in that
  // browser's format. Launching a different browser against it is broken
  // regardless of whether anything is running right now, so this refuses on
  // the recorded marker alone — it must NOT consult engine.sessionState.
  // (Switching becomes possible once `pwx forget` clears the marker.)
  //
  // `promote` gets the same guard for a different reason: it is destructive,
  // not merely broken. copyProfile() picks its prune/lock-file rules from
  // the adapter for ctx.browser, so `pwx promote --browser firefox` on a
  // session recorded as chromium would copy a Chromium-format profile into
  // golden/firefox using Firefox's rules, corrupting the golden every future
  // Firefox session seeds from. Every other verb that reads `recorded` only
  // fails to match the running browser's command line (an unreaped orphan,
  // a status line naming the wrong paths): wrong, but not destructive, so
  // it is deliberately not added here.
  if (recorded && recorded !== ctx.browser && ['open', 'fresh', 'promote'].includes(cmd)) {
    die(`session '${ctx.session}' is already running ${recorded}. Run 'pwx end' and then 'pwx forget' to switch to ${ctx.browser}.`)
  }

  if (!READ_ONLY.has(cmd)) session.touchLastUsed(ctx)
  // A fixed, predictable scratch directory under the system temp dir sits
  // inside a world-readable, world-writable location on a shared machine
  // (/tmp/pwx on Linux). It receives screenshots and page snapshots of
  // logged-in pages, so it is created owner-only, not at the platform default.
  session.mkdirPrivate(ctx.scratchDir, ctx.platform)

  switch (cmd) {
    case 'help': case '-h': case '--help':
      printHelp(ctx)
      await engine.run(ctx, ['--help'], { session: false })
      return

    case 'open': {
      for (const a of rest) { if (adapter.unsafeUrl(a)) die(`refusing download URL '${a}' — use the regular page URL instead (see skill docs).`) }
      const state = await engine.sessionState(ctx)
      if (state === 'unknown') {
        die("cannot tell whether your browser is running — 'list' failed twice. Refusing to relaunch, which would kill a live browser and any login it is holding. Retry in a moment, or run 'pwx status'.")
      }
      if (state === 'open') {
        if (!rest.length) { say(`session '${ctx.session}' already open (reusing). 'pwx status' to inspect; 'pwx fresh URL' to force a new browser.`); return }
        const r = await engine.run(ctx, ['goto', ...rest])
        if (r.code !== 0) {
          await session.killProfileBrowsers(ctx, adapter)
          die('goto failed — profile browsers killed, lock cleared. Re-run pwx open.')
        }
        return
      }
      const orphans = await session.profileBrowserPids(adapter, ctx.profileDir, { platform: ctx.platform })
      if (orphans.length) warn(`no live session for '${ctx.session}' — reaping the orphaned browser still holding your profile, then launching a new one.`)
      await session.killProfileBrowsers(ctx, adapter)
      const rows = await engine.listSessions(ctx)
      await session.sweepStale(ctx, { rows })
      await doLaunch(ctx, adapter, rest)
      return
    }

    case 'fresh':
      await session.captureStorageState(ctx, engine.run)
      await engine.run(ctx, ['close'], { capture: true })
      await session.killProfileBrowsers(ctx, adapter)
      await doLaunch(ctx, adapter, rest)
      return

    case 'end':
      await session.captureStorageState(ctx, engine.run)
      await engine.run(ctx, ['close'], { capture: true })
      await session.killProfileBrowsers(ctx, adapter)
      say(ctx.ephemeral
        ? `session '${ctx.session}' closed.`
        : `session '${ctx.session}' closed (login profile kept: ${ctx.profileDir}).`)
      return

    case 'show': case 'hide': {
      const wantHeadless = cmd === 'hide'
      session.setMode(ctx, wantHeadless ? 'headless' : 'headed')
      const state = await engine.sessionState(ctx)
      if (state !== 'open') {
        say(wantHeadless
          ? 'no session open; headless mode saved — future opens will be invisible.'
          : "no session open; headed mode saved — the next 'pwx open URL' will be visible.")
        return
      }
      const isHeaded = await engine.sessionHeaded(ctx)
      if (isHeaded === !wantHeadless) {
        say(wantHeadless ? 'browser is already headless.' : 'browser is already visible (headed).')
        return
      }
      say(`relaunching ${wantHeadless ? 'headless' : 'headed'} on the same profile (logins and page survive)…`)
      const got = await engine.run(ctx, ['--raw', 'eval', 'location.href'], { capture: true })
      let url = got.stdout.split('\n')[0].trim().replace(/^"|"$/g, '')
      if (!/^https?:\/\//.test(url)) url = ''
      await session.captureStorageState(ctx, engine.run)
      await engine.run(ctx, ['close'], { capture: true })
      await session.killProfileBrowsers(ctx, adapter)
      // The mode file was just written, so re-resolve to pick up the new mode.
      const next = resolveCtx({ argvBrowser: flagBrowser })
      await doLaunch(next, adapter, url ? [url] : [])
      return
    }

    case 'status': {
      const listing = await engine.run(ctx, ['list'], { capture: true, session: false })
      process.stdout.write(listing.stdout)
      say(ctx.isolated
        ? `this session: '${ctx.session}' (isolated; other rows above belong to other sessions)`
        : `this session: '${ctx.session}' (SHARED profile — other sessions can drive this browser)`)
      say(`browser: ${ctx.browser} (from ${ctx.browserSource})`)
      say(`profile: ${ctx.profileDir}`)
      say(`golden:  ${ctx.goldenDir}`)
      say(`daemon:  ${ctx.daemonDir}${fs.existsSync(ctx.daemonDir) ? '' : ' (missing)'}`)
      const state = await engine.sessionState(ctx)
      say(state === 'open' ? 'state: open' : `state: ${state === 'unknown' ? 'unknown' : "not open ('pwx open URL' to launch)"}`)
      say(`default mode: ${ctx.headless ? 'headless' : 'headed'} ('pwx show' / 'pwx hide' to switch)`)
      try {
        const stamp = Number(fs.readFileSync(path.join(ctx.stateDir, 'last-used'), 'utf8').trim())
        if (Number.isFinite(stamp) && stamp) say(`last used: ${new Date(stamp * 1000).toString()}`)
      } catch {}
      if (state !== 'open') {
        const orphans = await session.profileBrowserPids(adapter, ctx.profileDir, { platform: ctx.platform })
        if (orphans.length) {
          warn(`WARNING: orphaned browser process(es) holding the profile: ${orphans.join(' ')}`)
          warn("run 'pwx gc' to clean up ('pwx open URL' also reaps them automatically).")
        }
      }
      return
    }

    case 'gc': {
      const state = await engine.sessionState(ctx)
      if (state === 'open') {
        say(`session '${ctx.session}' is open and tracked — nothing to clean ('pwx end' closes it).`)
      } else if (state === 'unknown') {
        die("cannot tell whether your browser is running — 'list' failed twice. Refusing to reap, which could kill a live browser. Retry in a moment.")
      } else {
        await session.killProfileBrowsers(ctx, adapter)
        say(`cleaned up '${ctx.session}' — orphaned profile browsers reaped, stale locks cleared.`)
      }
      const rows = await engine.listSessions(ctx)
      const n = await session.sweepStale(ctx, { rows })
      if (n > 0) warn(`reaped ${n} stale session profile(s) (unused > ${ctx.ttlDays}d).`)
      return
    }

    case 'promote': {
      const state = await engine.sessionState(ctx)
      if (state === 'open') die("browser still running on this profile. Run 'pwx end' first, then 'pwx promote'.")
      const res = await session.promote(ctx, adapter)
      if (!res.ok) die(res.error)
      say(`promoted this session's logins to the golden profile (${ctx.goldenDir}).`)
      say("new sessions on this browser will start from it. 'PW_SEED=0' opts out; 'pwx forget --golden' clears it.")
      // The cookie count reads the on-disk cookie store only. When the golden
      // also carries a storage-state snapshot, the login travelled in that
      // snapshot and is applied on the next session's first launch, so an
      // empty on-disk store is expected rather than a problem. Warning there
      // would send the user chasing a failure that did not happen.
      if (res.cookies === 0 && !fs.existsSync(session.snapshotPath(ctx.goldenDir))) {
        warn('WARNING: the promoted profile has no stored cookies.')
        warn('Browsers flush cookies to disk on a timer; a login closed sooner is lost.')
        warn("leave the browser open ~a minute after logging in, then 'pwx end' and 'pwx promote'.")
      }
      return
    }

    case 'forget': case 'logout': {
      // Deliberately does not capture. The snapshot lives inside profileDir,
      // which this verb deletes a few lines below, so a capture here writes
      // a login snapshot only to have it removed unread a moment later —
      // pure waste, not a leftover-state risk. But forget's entire job is
      // "throw this session's login away", and capturing on the way out
      // means asking the browser to hand back exactly what forget is about
      // to discard, for a session that is not tracked afterward to ever use
      // it. That is the wrong instinct at a close site whose point is
      // erasure, even though nothing here is technically unsafe.
      await engine.run(ctx, ['close'], { capture: true })
      await session.killProfileBrowsers(ctx, adapter)
      fs.rmSync(ctx.profileDir, { recursive: true, force: true })
      session.mkdirPrivate(ctx.stateDir, ctx.platform)
      // Without this marker the next open silently re-seeds from golden and
      // lands logged back in, the opposite of what forget says.
      fs.writeFileSync(path.join(ctx.stateDir, 'no-seed'), '')
      // The open/fresh guard tells a user switching browsers to run 'pwx end'
      // then 'pwx forget'. That advice is a lie unless forget also clears the
      // recorded-browser marker — nothing else removes it.
      fs.rmSync(path.join(ctx.stateDir, 'browser'), { force: true })
      // A pending snapshot marker surviving a forget is stale: forget just
      // deleted the profile the marker refers to, and there is nothing left
      // to apply. Left behind, the next open would needlessly take the
      // pending-apply path and warn about a "carried-over login" forget was
      // just asked to erase.
      fs.rmSync(session.statePendingPath(ctx), { force: true })
      say(`cleared saved login (${ctx.profileDir}). Next 'pwx open' starts logged-out.`)
      if (rest[0] === '--golden') {
        fs.rmSync(ctx.goldenDir, { recursive: true, force: true })
        say(`also cleared the golden profile (${ctx.goldenDir}) — new sessions start logged-out too.`)
      } else if (session.dirHasContent(ctx.goldenDir)) {
        say("the golden profile still holds logins for NEW sessions ('pwx forget --golden' clears it too).")
      }
      return
    }

    case 'nuke': {
      if (rest[0] === '--all') {
        // Machine-wide, not scoped to ctx's session, so there is no single
        // profile whose live state to capture here — close-all/kill-all tear
        // down every session's daemon connection at once over commands that
        // take no session flag, not this session's own `close`. A session
        // closed this way keeps its disk profile (same as the scoped branch
        // below) but not a fresher live-state overlay on top of it.
        await engine.run(ctx, ['close-all'], { capture: true, session: false })
        await engine.run(ctx, ['kill-all'], { capture: true, session: false })
        await session.killProfileBrowsers(ctx, adapter)
        fs.rmSync(ctx.scratchDir, { recursive: true, force: true })
        say(`reset ALL sessions (every session's browser killed, scratch wiped: ${ctx.scratchDir}; login profiles kept)`)
      } else {
        await session.captureStorageState(ctx, engine.run)
        await engine.run(ctx, ['close'], { capture: true })
        await session.killProfileBrowsers(ctx, adapter)
        const rows = await engine.listSessions(ctx)
        await session.sweepStale(ctx, { rows })
        say(`reset '${ctx.session}' (its browser killed; login profile kept: ${ctx.profileDir} — 'pwx forget' to clear it)`)
        say(`other sessions and ${ctx.scratchDir} left alone ('pwx nuke --all' for the machine-wide reset)`)
      }
      return
    }

    case 'config': {
      if (rest[0] === 'set') {
        const [, key, value] = rest
        if (!['browser', 'headed', 'stateDir'].includes(key)) die(`unknown config key '${key}'. Keys: browser, headed, stateDir`)
        if (key === 'browser' && !BROWSERS.includes(value)) die(`unsupported browser '${value}'. Use one of: ${BROWSERS.join(', ')}`)
        const file = configPath(ctx.stateRoot)
        let cfg = {}
        try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
        cfg[key] = key === 'headed' ? value === 'true' : value
        session.mkdirPrivate(ctx.stateRoot, ctx.platform)
        fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
        say(`set ${key} = ${cfg[key]} in ${file}`)
        return
      }
      const rows = [
        ['browser', ctx.browser, ctx.browserSource],
        ['headed', String(!ctx.headless), ctx.headless === undefined ? 'default' : 'resolved'],
        ['stateRoot', ctx.stateRoot, process.env.PW_STATE_ROOT ? 'env' : (ctx.config.stateDir ? 'config' : 'default')],
        ['scratchDir', ctx.scratchDir, process.env.PW_SCRATCH_DIR ? 'env' : 'default'],
        ['daemonDir', ctx.daemonDir, 'derived']
      ]
      for (const [k, v, s] of rows) process.stdout.write(`${k.padEnd(12)} ${String(v).padEnd(40)} ${s}\n`)
      say(`config file: ${configPath(ctx.stateRoot)}`)
      return
    }

    case 'menu': {
      const picked = await runMenu(ctx)
      if (!picked.length) return
      const { execFileSync } = await import('node:child_process')
      try {
        execFileSync(process.execPath, [process.argv[1], ...picked], { stdio: 'inherit' })
      } catch (e) {
        process.exit(e.status ?? 1)
      }
      return
    }

    case 'selftest': {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwx-selftest-'))
      const env = {
        ...process.env,
        PW_SESSION: 'pwx-selftest',
        PW_PROFILE_DIR: path.join(tmp, 'profile'),
        PW_SCRATCH_DIR: path.join(tmp, 'scratch'),
        PW_BROWSER: ctx.browser
      }
      const { execFileSync } = await import('node:child_process')
      let rc = 0
      try {
        execFileSync(process.execPath, [process.argv[1], 'open', 'about:blank'], { env, stdio: 'ignore' })
        const out = execFileSync(process.execPath, [process.argv[1], 'list', '--json'], { env, encoding: 'utf8' })
        const row = engine.sessionRow(engine.parseBrowsers(out), 'pwx-selftest')
        if (!row) { process.stderr.write(`FAIL: session 'pwx-selftest' is not in the browser list\n`); rc = 1 } else if (row.headed === ctx.headless) { process.stderr.write(`FAIL: session mode mismatch (want headed=${!ctx.headless})\n`); rc = 1 }
      } catch (e) {
        process.stderr.write(`FAIL: ${e.message}\n`); rc = 1
      } finally {
        try { execFileSync(process.execPath, [process.argv[1], 'end'], { env, stdio: 'ignore' }) } catch {}
        fs.rmSync(tmp, { recursive: true, force: true })
      }
      if (rc === 0) {
        process.stdout.write(`PASS: ${ctx.headless ? 'headless' : 'headed'}, single session, ${ctx.browser}, artifacts -> ${ctx.scratchDir}\n`)
      }
      process.exit(rc)
    }

    default: {
      if (WRAPPER_VERBS.has(cmd)) die(`verb '${cmd}' is not implemented yet.`)
      const r = PASSTHROUGH_NO_SESSION.has(cmd)
        ? await engine.run(ctx, argv, { session: false })
        : await engine.run(ctx, argv)
      process.exit(r.code)
    }
  }
}

function printHelp (ctx) {
  const mode = ctx.headless ? 'headless (invisible)' : 'headed (visible)'
  const scope = ctx.isolated ? 'isolated to this agent session' : 'shared (no CLAUDE_CODE_SESSION_ID, or PW_PROFILE_DIR set)'
  process.stdout.write(`pwx — browser wrapper (session '${ctx.session}', ${scope}; ${ctx.browser}; currently ${mode}; artifacts in ${ctx.scratchDir})

  pwx open URL       open (or reuse) this session's browser and navigate
  pwx open --browser firefox URL   same, on Firefox (per session; chromium is the default)
  pwx show           make the browser visible (relaunch headed; logins + page survive)
  pwx hide           make the browser invisible again (relaunch headless)
  pwx status         session name, browser, profile, mode, last used, orphan warnings
  pwx gc             reap this session's orphaned browsers + stale locks + old profiles
  pwx fresh URL      force a NEW browser (close current, relaunch)
  pwx promote        save this session's logins as the golden seed for new sessions
  pwx forget         clear the saved login (--golden also clears the seed)
  pwx end            close the session (saved login persists on disk)
  pwx nuke           reset THIS session (--all resets every session)
  pwx config         show or set machine defaults (browser, headed)
  pwx menu           interactive picker
  pwx selftest       verify session mode + no repo litter

Profile: ${ctx.profileDir}
Golden:  ${ctx.goldenDir}
All other commands pass through to playwright-cli, scoped to '${ctx.session}'.
playwright-cli's own help follows:
`)
}

main().catch(e => die(e.stack || String(e)))
