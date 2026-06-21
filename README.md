# use-browser

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![requires: playwright-cli](https://img.shields.io/badge/requires-playwright--cli-blue.svg)](https://www.npmjs.com/package/@playwright/cli)

> **Prerequisite:** the [`playwright-cli`](https://www.npmjs.com/package/@playwright/cli)
> binary (`npm i -g @playwright/cli@latest`). The installer checks for it.

A Claude Code skill that wraps `playwright-cli` with a `pw` command so the
agent drives the browser the way you want:

- headed by default (you can watch),
- one reusable session (no zombie browsers, no proliferation),
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

- `pw open <url>` — open or reuse the session and navigate
- `pw status` — show what is running
- `pw fresh <url>` — force a brand-new browser (rare)
- `pw forget` — clear the saved login (delete the persistent profile)
- `pw end` — close the session (saved login persists on disk)
- `pw nuke` — kill everything and wipe the scratch dir (login profile kept)
- `pw selftest` — verify headed mode and no repo litter

All other commands pass through to `playwright-cli`.

Because the browser uses a persistent on-disk profile, the first time you hit a
site's login or 2FA wall a human completes it in the headed window; after that
the session is reused and you are not prompted again.

## Configuration

- `PW_SESSION` — session name (default `pw`)
- `PW_SCRATCH_DIR` — artifact scratch dir (default `${TMPDIR:-/tmp}/pw-cli`)
- `PW_PROFILE_DIR` — persistent login profile (default `~/.cache/pw-cli/profile`)
- `PW_EPHEMERAL=1` — use a throwaway in-memory profile (saves no login)
- `PW_BIN` — `playwright-cli` binary (default `playwright-cli`)
