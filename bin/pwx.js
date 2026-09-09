#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolve as resolveCtx, configPath, BROWSERS, ATTACH_SESSION_NAME } from '../lib/config.js'
import { get as getAdapter } from '../lib/browsers/index.js'
import { macChromeWarning } from '../lib/browsers/chromium.js'
import * as engine from '../lib/engine.js'
import * as session from '../lib/session.js'
import { runMenu } from '../lib/menu.js'

const PASSTHROUGH_NO_SESSION = new Set(['list', 'close-all', 'kill-all', 'install', '--version', '-V'])
const WRAPPER_VERBS = new Set([
  'help', '-h', '--help', 'open', 'fresh', 'end', 'show', 'hide', 'status',
  'gc', 'promote', 'forget', 'logout', 'nuke', 'selftest', 'config', 'menu',
  'attach', 'detach'
])
const READ_ONLY = new Set(['help', '-h', '--help', 'status', 'gc', 'list', 'selftest', 'config', '--version', '-V'])
const DEFAULT_ATTACH_CHANNEL = 'chrome'
// These verbs are only meaningful for a browser and profile pwx launched and
// owns itself — they relaunch, seed, promote, or erase a profile directory,
// or otherwise assume pwx can freely restart the browser. An attached
// session's browser is someone's real, already-running browser held over the
// Playwright extension: pwx did not launch it, must never restart or kill
// it, and has no profile of its own to seed/promote/erase. Refusing here,
// before any of these verbs' bodies run, is what keeps their internal calls
// to the process-killing/profile-deleting helpers in lib/session.js from
// ever being reached in attach mode — see 'open', 'end', 'status', 'gc', and
// 'nuke' below for the verbs that instead get their own attach-aware branch.
const ATTACH_LOCKED = new Set(['fresh', 'show', 'hide', 'promote', 'forget', 'logout'])

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
  const chromeWarning = macChromeWarning(adapter.name, ctx.platform)
  if (chromeWarning) warn(chromeWarning)
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

  if (ctx.attached && ATTACH_LOCKED.has(cmd)) {
    die(`session '${ctx.session}' is attached to your real ${ctx.attachedChannel} browser — '${cmd}' assumes pwx owns the browser and its profile, which isn't true here. 'pwx end' detaches (your browser stays open and untouched); 'pwx status' shows the attached state.`)
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
      // An attached session's browser is the owner's real, already-running
      // one — it is never something pwx launched, so there is no orphan of
      // ours to reap and no profile of ours to launch a fresh browser onto.
      // Refusing here, before profileBrowserPids/killProfileBrowsers run,
      // keeps this reap-orphans path from ever executing in attach mode.
      if (ctx.attached) {
        die(`session '${ctx.session}' was attached to your real ${ctx.attachedChannel} browser but is no longer connected. Run 'pwx attach' to reconnect — 'pwx open' will not launch a browser of its own for an attached session.`)
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
      // An attached session's browser is the owner's real one, holding every
      // account they are signed into. 'end' must detach and leave it running
      // and untouched — never capture/close/kill, which all assume pwx owns
      // the browser it is shutting down. `detach` only tears down pwx's own
      // extension connection; the browser survives it regardless of outcome,
      // so a non-zero exit here is reported but still treated as "done".
      //
      // The connection it tears down is the single SHARED one every attached
      // Claude session uses (ctx.session is ATTACH_SESSION_NAME here) — this
      // disconnects every session that joined it, not just this one, so the
      // message says that plainly rather than implying a private teardown.
      if (ctx.attached) {
        const r = await engine.run(ctx, ['detach'], { capture: true })
        session.clearAttached(ctx)
        if (r.code !== 0) warn(`detach reported a problem (exit ${r.code}) — your browser was not touched either way. 'pwx status' to check.`)
        say(`detached the shared attach connection — if another Claude session had joined it, that session is disconnected too. Your ${ctx.attachedChannel} browser itself is untouched and still running.`)
        return
      }
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
      // An attached session has no pwx-owned profile or golden directory —
      // printing those paths would name locations that do not apply to it
      // and imply pwx owns state that it does not.
      if (ctx.attached) {
        say(`this agent (${ctx.ownSession}) is ATTACHED, via the shared connection '${ctx.session}', to your real ${ctx.attachedChannel} browser (pwx does not own this browser or its profile; any Claude session can join the same connection with 'pwx attach')`)
        const attachedState = await engine.sessionState(ctx)
        say(attachedState === 'open'
          ? 'state: attached and connected'
          : attachedState === 'unknown'
            ? 'state: unknown'
            : "state: not connected ('pwx attach' to reconnect; 'pwx end' clears the marker)")
        try {
          const stamp = Number(fs.readFileSync(path.join(ctx.stateDir, 'last-used'), 'utf8').trim())
          if (Number.isFinite(stamp) && stamp) say(`last used: ${new Date(stamp * 1000).toString()}`)
        } catch {}
        return
      }
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
      // Nothing to reap for an attached session: there is no pwx-owned
      // profile browser to have gone orphan in the first place. Branching
      // here, rather than letting killProfileBrowsers' own attach guard
      // silently no-op, keeps that helper out of this call path entirely and
      // avoids a "cleaned up" message that implies pwx reaped something.
      if (ctx.attached) {
        const attachedState = await engine.sessionState(ctx)
        say(attachedState === 'open'
          ? `the shared attach connection '${ctx.session}' is connected — nothing to clean (pwx does not own this browser).`
          : `this agent (${ctx.ownSession}) is marked attached, but the shared connection '${ctx.session}' is not currently connected — 'pwx attach' to (re)join it, or 'pwx end' to clear the marker. Nothing to reap: pwx does not own this browser.`)
        const attachedRows = await engine.listSessions(ctx)
        const attachedN = await session.sweepStale(ctx, { rows: attachedRows })
        if (attachedN > 0) warn(`reaped ${attachedN} stale session profile(s) (unused > ${ctx.ttlDays}d).`)
        return
      }
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
        // killProfileBrowsers targets THIS ctx's own profile directory only;
        // an attached ctx has none, and "nothing may kill or terminate a
        // browser process" holds regardless of which verb is asking, so the
        // call is skipped outright here rather than left to that helper's
        // own attach guard.
        if (!ctx.attached) await session.killProfileBrowsers(ctx, adapter)
        fs.rmSync(ctx.scratchDir, { recursive: true, force: true })
        say(`reset ALL sessions (every session's browser killed, scratch wiped: ${ctx.scratchDir}; login profiles kept)`)
      } else if (ctx.attached) {
        // Scoped nuke captures, closes, and kills THIS session's own browser
        // and keeps its profile — every part of that assumes pwx owns the
        // browser it is resetting, which isn't true for an attached session.
        die(`session '${ctx.session}' is attached to your real ${ctx.attachedChannel} browser — there is nothing pwx-owned to reset. 'pwx end' detaches (your browser stays open).`)
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

    case 'attach': {
      // Explicit, named verb rather than a flag on 'open' — attaching hands
      // pwx control of the owner's real browser instead of one it launches
      // itself, so it must be something the user types on purpose, not a
      // side effect of an ordinary open/goto call.
      if (flagBrowser) die(`'pwx attach' takes the extension channel as a plain argument, not --browser: run 'pwx attach ${flagBrowser}'.`)
      const channel = rest[0] || DEFAULT_ATTACH_CHANNEL

      if (!ctx.attached) {
        // This agent has not joined attach mode yet: make sure it doesn't
        // already have its own, pwx-launched browser open under its own
        // per-agent session before handing that identity over to the shared
        // one below. (ctx.session === ctx.ownSession here, since the
        // override in lib/config.js only applies once ctx.attached is true.)
        const ownState = await engine.sessionState(ctx)
        if (ownState === 'open') die(`session '${ctx.session}' already has a browser open that pwx launched itself. Run 'pwx end' first, then 'pwx attach' to join the shared attached browser.`)
        if (ownState === 'unknown') die("cannot tell whether a browser is already running — 'list' failed twice. Retry in a moment before attaching.")
      }

      // Attach mode's session name is the one fixed constant
      // ATTACH_SESSION_NAME, shared by every Claude session, so that any of
      // them can join the same real-browser connection with no coordination
      // and nothing to look up. ctx.session already equals it once
      // ctx.attached is true (lib/config.js); `shared` reconstructs the same
      // targeting by hand for the first-time-this-agent case, so a cold
      // attach can still see whether some OTHER Claude session already
      // established the shared connection.
      const shared = ctx.attached ? ctx : { ...ctx, session: ATTACH_SESSION_NAME }
      const rows = await engine.listSessions(shared)
      if (rows === null) die("cannot tell whether the shared attach connection is already open — 'list' failed twice. Retry in a moment before attaching.")
      const sharedRow = engine.sessionRow(rows, ATTACH_SESSION_NAME)

      if (sharedRow && sharedRow.status === 'open') {
        // Someone, this agent or another Claude session, is already
        // attached and connected. Join it — never open a second connection
        // (and a second connect-page tab) on top of it.
        if (sharedRow.browserType && sharedRow.browserType !== channel) {
          die(`the shared attach connection is already attached to ${sharedRow.browserType}, not ${channel}. Run 'pwx end' to drop it if you really want to switch, then 'pwx attach ${channel}'.`)
        }
        session.setAttached(ctx, sharedRow.browserType || channel)
        say(`joining the existing shared attach connection (${sharedRow.browserType || channel}) — no new connection was opened.`)
        return
      }

      // Not open anywhere: establish it.
      // PLAYWRIGHT_MCP_EXTENSION_TOKEN, if set, is read straight out of the
      // environment by the engine (engine.run forwards process.env
      // unchanged) — it is never read, logged, or passed explicitly here.
      if (!process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN) {
        warn('no PLAYWRIGHT_MCP_EXTENSION_TOKEN set — a new tab is about to open in your browser asking you to approve the Playwright extension connection. Approve it there; this command will continue once you do (it is not hung).')
      }
      // capture: true, deliberately never printed below. playwright-cli's own
      // attach output includes the extension connect page's full URL, which
      // carries PLAYWRIGHT_MCP_EXTENSION_TOKEN as a query parameter in
      // cleartext — inheriting stdio here would print a credential to every
      // terminal (and every log/transcript capturing it) that runs this verb.
      const r = await engine.run(shared, ['attach', `--extension=${channel}`], { capture: true })
      if (r.code !== 0) die(`attach failed (exit ${r.code}) — your browser was not touched.`)
      session.setAttached(ctx, channel)
      say(`attached to your real ${channel} browser via the extension, on the shared session '${ATTACH_SESSION_NAME}' — any Claude session can join it with a plain 'pwx attach', no flags to pass. 'pwx end' detaches without closing your browser (and disconnects any other session that had joined it).`)
      return
    }

    case 'detach': {
      const r = await engine.run(ctx, ['detach'])
      if (ctx.attached) session.clearAttached(ctx)
      process.exit(r.code)
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
  pwx open --browser chrome URL    same, on real installed Google Chrome
  pwx open --browser msedge URL    same, on real installed Microsoft Edge
  pwx show           make the browser visible (relaunch headed; logins + page survive)
  pwx hide           make the browser invisible again (relaunch headless)
  pwx status         session name, browser, profile, mode, last used, orphan warnings
  pwx gc             reap this session's orphaned browsers + stale locks + old profiles
  pwx fresh URL      force a NEW browser (close current, relaunch)
  pwx promote        save this session's logins as the golden seed for new sessions
  pwx forget         clear the saved login (--golden also clears the seed)
  pwx end            close the session (saved login persists on disk)
  pwx nuke           reset THIS session (--all resets every session)
  pwx attach [chrome]  attach to YOUR real, already-running browser via the extension (shared by every agent session; 'pwx end' detaches, leaves it running)
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
