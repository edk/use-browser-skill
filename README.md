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
