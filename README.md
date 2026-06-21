# use-browser

A Claude Code skill that wraps `playwright-cli` with a `pw` command so the
agent drives the browser the way you want:

- headed by default (you can watch),
- one reusable session (no zombie browsers, no proliferation),
- all snapshots/screenshots/traces written to a scratch dir, never into your repo.

## Install

```bash
git clone <repo-url> ~/code/use-browser-skill
bash ~/code/use-browser-skill/install.sh
pw selftest
```

Requires the `playwright-cli` binary (`npm i -g @playwright/cli@latest`); the
installer checks for it. The installer moves any existing upstream
`playwright-cli` skill aside so only `use-browser` triggers — do not run
`playwright-cli install --skills` afterward.

## Use

In a Claude conversation, ask for browser work; the skill drives `pw`.
`pw help` lists the wrapper verbs (`status`, `end`, `nuke`, `selftest`); all
other commands pass through to `playwright-cli`.

## Configuration

- `PW_SESSION` (default `pw`), `PW_SCRATCH_DIR` (default `${TMPDIR:-/tmp}/pw-cli`),
  `PW_BIN` (default `playwright-cli`).
