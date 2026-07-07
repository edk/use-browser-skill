# use-browser

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![requires: playwright-cli](https://img.shields.io/badge/requires-playwright--cli-blue.svg)](https://www.npmjs.com/package/@playwright/cli)

> **Prerequisite:** the [`playwright-cli`](https://www.npmjs.com/package/@playwright/cli)
> binary (`npm i -g @playwright/cli@latest`). The installer checks for it.

A Claude Code skill that wraps `playwright-cli` with a `pw` command so the
agent drives the browser the way you want:

- headless by default (invisible, no desktop clutter); `pw show` relaunches it
  visibly on the same profile and page when a human needs to see or act,
- one reusable session (no zombie browsers, no proliferation), with orphan
  reaping built into `pw open`, `pw gc`, and `pw end`,
- a persistent login profile — sign in (and pass 2FA) once, and the session
  sticks across launches and tasks,
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
- `pw status` — session, mode, last used, orphan warnings
- `pw gc` — reap orphaned profile browsers and clear stale locks
- `pw fresh <url>` — force a brand-new browser (rare)
- `pw forget` — clear the saved login (delete the persistent profile)
- `pw end` — close the session (saved login persists on disk)
- `pw nuke` — kill everything and wipe the scratch dir (login profile kept)
- `pw selftest` — verify session mode and no repo litter

All other commands pass through to `playwright-cli`.

Because the browser uses a persistent on-disk profile, the first time you hit a
site's login or 2FA wall the agent runs `pw show` and a human completes it in
the visible window; after that the session is reused and you are not prompted
again.

## Configuration

- `PW_SESSION` — session name (default `pw`)
- `PW_SCRATCH_DIR` — artifact scratch dir (default `${TMPDIR:-/tmp}/pw-cli`)
- `PW_PROFILE_DIR` — persistent login profile (default `~/.cache/pw-cli/profile`)
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
