# use-browser

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![requires: playwright-cli](https://img.shields.io/badge/requires-playwright--cli-blue.svg)](https://www.npmjs.com/package/@playwright/cli)

> **Prerequisite:** the [`playwright-cli`](https://www.npmjs.com/package/@playwright/cli)
> binary (`npm i -g @playwright/cli@latest`). The installer checks for it.

A Claude Code skill that wraps `playwright-cli` with a `pw` command so the
agent drives the browser the way you want:

- headed by default (you can watch); `pw hide` relaunches it headless on the
  same profile and page for invisible background work (`pw show` to bring it
  back) — headless also sidesteps headed Chrome's replayd connection storms,
- one reusable browser per agent session (no zombie browsers, no proliferation),
  with orphan reaping built into `pw open`, `pw gc`, and `pw end`,
- per-session isolation: concurrent agent sessions each get their own browser
  and profile, so one session can never navigate or reap another's browser,
- a persistent login profile — sign in (and pass 2FA) once, and it sticks for
  the rest of that session; `pw promote` carries those logins to new sessions,
- all snapshots/screenshots/traces written to a scratch dir, never into your repo.

## Install

```bash
git clone https://github.com/edk/use-browser-skill.git
cd use-browser-skill
bash install.sh
pw selftest
```

Requires the `playwright-cli` binary (`npm i -g @playwright/cli@latest`); the
installer checks for it. The installer moves any existing upstream
`playwright-cli` skill aside so only `use-browser` triggers — do not run
`playwright-cli install --skills` afterward.

## Use

In a Claude conversation, ask for browser work; the skill drives `pw`. `pw help`
lists the wrapper verbs:

- `pw open <url>` — open or reuse the session and navigate (reaps orphans first)
- `pw show` / `pw hide` — make the browser visible / invisible (same profile and page)
- `pw status` — your session name and profile, mode, last used, orphan warnings
- `pw gc` — reap your orphaned browsers, stale locks, and abandoned profiles
- `pw fresh <url>` — force a brand-new browser (rare)
- `pw promote` — save this session's logins as the seed for new sessions
- `pw forget` — clear this session's login (`--golden` also clears the seed)
- `pw end` — close the session (saved login persists on disk)
- `pw nuke` — reset this session (`--all` resets every session on the machine)
- `pw selftest` — verify session mode and no repo litter

All other commands pass through to `playwright-cli`.

Because the browser uses a persistent on-disk profile, the first time you hit a
site's login or 2FA wall the agent runs `pw show` and a human completes it in
the visible window; after that the browser is reused and you are not prompted
again for the rest of that session.

## Sessions and logins

Session name and profile are keyed on `CLAUDE_CODE_SESSION_ID`, so two agent
sessions running at once get two browsers and two profiles. Chromium cannot open
two instances against one `userDataDir`, so separate windows require separate
profiles: the two cannot be decoupled.

The consequence is that a brand-new session does not automatically see the
previous one's logins. `pw promote` closes that gap: run `pw end`, then
`pw promote`, and the profile is copied to `~/.cache/pw-cli/golden`, which every
new session is seeded from on its first launch. Leave the browser open about a
minute after logging in before `pw end`, since Chromium flushes cookies to disk
on a roughly 30 second timer and Playwright kills the browser on teardown.

Profile copies skip Chromium's HTTP, code, and service-worker caches, which hold
no auth state and dominate a long-lived profile (859 MB down to 22 MB, 7.2 s
down to 0.23 s on a real one). Tab-restore state is skipped too, so a new
session does not reopen the golden profile's tabs.

With no `CLAUDE_CODE_SESSION_ID` (a plain terminal), `pw` falls back to the
historical single shared session `pw` and profile `~/.cache/pw-cli/profile`.
Setting `PW_PROFILE_DIR` explicitly opts back into that shared behaviour.

## Configuration

- `PW_SESSION` — session name (default: `pw-<session-key>`, or `pw` with no
  `CLAUDE_CODE_SESSION_ID`)
- `PW_SCRATCH_DIR` — artifact scratch dir (default `${TMPDIR:-/tmp}/pw-cli`)
- `PW_CACHE_DIR` — state root (default `~/.cache/pw-cli`)
- `PW_PROFILE_DIR` — explicit login profile; setting it opts back into one
  profile shared by every session (default: per-session under `PW_CACHE_DIR`)
- `PW_GOLDEN_DIR` — seed profile for new sessions (default `~/.cache/pw-cli/golden`)
- `PW_SEED=0` — do not seed new sessions from the golden profile
- `PW_SESSION_TTL_DAYS` — age at which `pw gc` reaps an unused session profile
  (default 7)
- `PW_EPHEMERAL=1` — use a throwaway in-memory profile (saves no login)
- `PW_BIN` — `playwright-cli` binary (default `playwright-cli`)
- `PLAYWRIGHT_MCP_HEADLESS=true|false` — one-off mode override; normally leave
  unset and use `pw show`/`pw hide` (do not pin it in Claude settings.json —
  that defeats mode switching)

## macOS: replayd / ScreenCaptureKit CPU

Two separate things can pin CPU on macOS:

- playwright-core's CDP screenshot defaults to `fromSurface: true`, routing
  every capture through ScreenCaptureKit/replayd (~1 core per busy browser).
  Run `bin/patch-screencapture` once per `@playwright/cli` install/update,
  then `playwright-cli kill-all` to reload the daemon.
- replayd itself can wedge and burn 50-100% CPU indefinitely after a capture
  client disappears (known macOS bug, not specific to pw). Fix:
  `killall replayd` — it is an on-demand daemon and relaunches cleanly.
  Headless mode avoids most SCK involvement in the first place.

## pwx: the in-development Node port

This repo also contains `pwx`, a Node rewrite of `pw` living in `bin/pwx.js`
and `lib/`. It adds Firefox alongside Chromium and support for Ubuntu Linux
and native Windows 10, on top of everything `pw` already does. It does not
touch `bin/pw` or `install.sh`; installing or running `pwx` cannot affect
the `pw` command described above.

### Requirements

Node 20 or later. This is `pwx`'s own floor, declared in its
`package.json` under `engines`; it is higher than the Node 18 that
`@playwright/cli` itself requires.

### Install from a clone

The same steps work on macOS, Ubuntu, and Windows 10:

```bash
git clone https://github.com/edk/use-browser-skill.git
cd use-browser-skill
npm install
node node_modules/@playwright/cli/playwright-cli.js install-browser chromium --with-deps
node node_modules/@playwright/cli/playwright-cli.js install-browser firefox --with-deps
npm install -g .
pwx selftest
```

`npm install -g .` reads the `bin` entry in `package.json` and puts a `pwx`
command on PATH: a symlink on macOS and Ubuntu, an npm-generated `pwx.cmd`
shim on Windows. Run it from the shell you plan to drive `pwx` from later
(PowerShell or the Git Bash Claude Code uses on Windows); npm resolves the
right shim on PATH either way. `--with-deps` also installs the Linux
system packages each browser needs; on Ubuntu this step may prompt for
`sudo`.

### pwx versus pw during development

`pwx` and `pw` are separate commands with separate state, so running one
cannot disturb a login, profile, or browser session that belongs to the
other. `pw` keeps its state under `~/.cache/pw-cli`; `pwx` keeps its state
under `~/.cache/pwx`, an entirely different directory, and never reads or
writes anything under `~/.cache/pw-cli`. The same separation holds for
scratch and artifact directories. This lasts through development; a later
cutover step, not part of this port, renames `pwx` to `pw` and moves it
onto `pw`'s state paths.

`pwx` reads `PW_STATE_ROOT` and deliberately ignores `PW_CACHE_DIR`, which
is `pw`'s own state-root override. Honouring both would have made that
separation untrue for anyone with `PW_CACHE_DIR` exported: `pwx` would
migrate `pw`'s golden profile into the new layout and then reap `pw`'s live
browser as an orphan. To point `pwx` somewhere else, set `PW_STATE_ROOT`.

### Where pwx state lives

State root: `~/.cache/pwx` (override with `PW_STATE_ROOT`, or `stateDir` in
the config file). Directories `pwx` creates are owner-only: the storage-state
snapshot beside each profile holds session cookies in plaintext, unlike
Chromium's own keychain-encrypted cookie store.

```
config.json          machine defaults: browser, headed, stateDir
golden/chromium/      seed profile for new Chromium sessions
golden/chrome/         seed profile for new real-Chrome sessions
golden/msedge/         seed profile for new real-Edge sessions
golden/firefox/       seed profile for new Firefox sessions
sessions/<key>/       one directory per agent session
  profile/            that session's live browser profile
  browser              which browser this session recorded at open
  mode                 headed or headless
  attached              present only after `pwx attach`; names the extension channel
  last-used            epoch seconds, used by pwx gc
profile/              legacy shared profile when there is no session id
```

Scratch and artifacts (screenshots, traces, and similar) go to a `pwx`
subdirectory under the operating system's temp directory, never into a
repo, separately from `pw`'s own scratch directory.

### Attaching to your real browser

`pwx open` normally launches a browser pwx owns: a separate profile it
seeds, promotes, and can freely relaunch or kill. `pwx attach` is the
opposite: it connects pwx to *your own, already-running* browser over the
Playwright extension, instead of launching one of its own. This matters on
sites that block a Playwright-launched browser (Cloudflare's challenge page,
for example) but load fine in a real browser with your own profile, history,
and IP.

```
pwx attach            attach to your real, already-running Chrome
pwx attach msedge     same, but to a running Edge instead
```

The Playwright extension must already be installed in that browser. Set
`PLAYWRIGHT_MCP_EXTENSION_TOKEN` in your shell profile beforehand so the
attach happens without a manual approval click; without it, attaching opens
a new tab asking you to approve the connection, and `pwx attach` waits for
that click rather than hanging silently.

Once attached, a session is marked as such (the `attached` file above) for
every later `pwx <verb>` invocation, which is a separate process each time.
Ordinary verbs — `goto`, `eval`, `snapshot`, `screenshot`, and the rest —
drive the real browser exactly as they would an owned one. But an attached
session's browser is not pwx's to launch, seed, or kill, so:

- `pwx end` detaches and leaves your browser open and untouched, rather than
  closing and killing it.
- `pwx fresh`, `pwx show`/`pwx hide`, `pwx promote`, and `pwx forget` all
  refuse outright, since each assumes pwx owns the profile it is
  relaunching, seeding, or erasing.
- `pwx status` and `pwx gc` report the attached state instead of profile and
  golden paths that do not apply.

### Running the test suites

```bash
npm test                                    # unit tests
PWX_INTEGRATION=1 npm run test:integration  # integration tests
```

`npm test` runs the unit suite in `test/unit` against a stub
`playwright-cli` and needs no real browser. The integration suite in
`test/integration` drives real headless Chromium and Firefox sessions
against a local HTTP server; it is gated behind `PWX_INTEGRATION=1` so it
never runs by accident, and it needs both browsers installed first with
the `install-browser` commands shown above, or it fails outright.

### How promote survives an immediate end

`pw` (the bash tool) relies on Chromium's own on-disk cookie flush, on a
roughly 30 second timer, to have a login on disk by the time `pw promote`
copies the profile; that is why the advice above says to wait a minute
after logging in before `pw end`. `pwx` removes that wait: before `pwx
end` closes the browser, it captures the browser's live storage state and
carries it alongside the profile through `pwx promote`, and the next
session's first `pwx open` applies it before that session's first page
loads. In practice, with `pwx`, log in, `pwx end`, `pwx promote`, with no
wait required in between.

`pwx promote` warns when the promoted profile has no stored cookies, but
only when the golden profile carries no storage-state snapshot either. When
a snapshot did travel with the profile, an empty on-disk cookie database is
the expected state rather than a failure, so no warning is printed.
