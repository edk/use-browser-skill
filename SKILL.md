---
name: use-browser
description: Use when driving a web browser to get something done — navigating to a page, clicking, filling or submitting a form, taking a screenshot, scraping or extracting data from a page, logging into a site, or testing a web page. For agent-driven browser automation of any site. Not for shared interactive debugging of your own running app — that is cosession.
allowed-tools: Bash(pw:*)
---

# use-browser

Drive a real browser from the terminal with `pw`. Headed by default, one
reusable session, and all artifacts written outside your repos.

## The one rule

Use `pw` for all browser work. Never call `playwright-cli` directly — `pw`
sets headed mode, the artifact location, and the shared session for you. If
`pw` is not on PATH, call it at `~/.claude/skills/use-browser/bin/pw`.

## Lifecycle (this is what keeps it tidy)

- One session per task. Just run `pw open <url>` and keep going; `pw` reuses
  the same browser instead of spawning new ones.
- `pw end` when you are done with the browser.
- `pw status` to see what is running; `pw nuke` to kill everything and wipe
  the scratch dir.

## Common commands

```bash
pw open https://example.com     # launch (or reuse) the session and navigate
pw snapshot                     # structured page snapshot with element refs
pw click e15                    # act on a ref from the snapshot
pw fill e5 "user@example.com" --submit
pw type "search text"
pw screenshot --filename=shot.png
pw eval "document.title"
pw --raw eval "JSON.stringify(...)"   # clean output for piping
```

Full command surface: `pw --help` (it appends `playwright-cli --help`).

## Logged-in sites

For pages behind a login (Reddit, broker dashboards, anything requiring
auth), open with `--persistent` and save/reuse credentials with `state-save`
/ `state-load` — the default profile is in-memory and drops the session when
the browser closes.

## Artifacts

Snapshots, screenshots, and traces go to a scratch dir outside any repo
automatically. Do not write output paths into the project tree.
