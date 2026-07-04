---
name: use-browser
description: Use when driving a web browser to get something done — navigating to a page, clicking, filling or submitting a form, taking a screenshot, scraping or extracting data from a page, logging into a site, or testing a web page. For agent-driven browser automation of any site. Not for shared interactive debugging of your own running app — that is cosession.
allowed-tools: Bash(pw:*)
---

# use-browser

Drive a real browser from the terminal with `pw`. Headed by default, ONE
reusable session, a persistent login profile, and all artifacts written outside
your repos.

## The one rule

Use `pw` for all browser work. Never call `playwright-cli` directly — `pw`
sets headed mode, the artifact location, the persistent profile, and the shared
session for you. If `pw` is not on PATH, call it at
`~/.claude/skills/use-browser/bin/pw`.

## Session discipline — one browser, no orphans

There is ONE browser window shared across tasks. Breaking this discipline leaves
abandoned Chrome windows on the desktop.

- **Never use a custom session name.** Do not pass `-s=`, `--session`, or any
  other flag that would create a named session other than the default `pw`.
  Every `pw` command uses the same session automatically.
- **Never call `playwright-cli` directly.** Only ever call `pw`. Direct
  `playwright-cli` calls bypass session tracking and can spawn unmanaged browsers.
- **`pw open <url>` navigates the existing browser.** It does not open a second
  one. To visit another URL, just run `pw open <url>` again.
- **`pw end` when the task is done.** This saves login state and kills the browser
  cleanly. If the user says to keep the browser open (e.g. to continue work),
  skip `pw end` and say so explicitly.
- **Do NOT call `pw end` between steps within a task** — that throws away the
  session. Only call it when the whole task is finished.
- **`pw fresh <url>` is rare** — only for a genuinely clean slate (switching
  accounts, corrupted state). It closes the current browser and opens a new one.

## Logins and 2FA — STOP, do not push through

The browser uses a persistent on-disk profile, so a human logs in (and passes
2FA) ONCE and it sticks across launches and tasks. Session cookies are also saved
on `pw end` and restored on the next `pw open`, so even browser restarts stay
logged in. The first time you hit a site's auth wall, a human has to complete
it — you cannot.

After `pw open` / navigation, take a `pw snapshot`. If the page is a login,
SSO, "verify it's you", 2FA, or authenticator screen instead of the content you
asked for:

1. **STOP.** Do not click through, do not type credentials or codes, do not
   assume the page loaded, do not move on to the next URL.
2. **Hand off to the human.** Say something like: "Jira is showing a login
   screen in the browser window — please sign in there, then tell me to
   continue." The browser is headed; they can see and act on it.
3. **Wait** for the human to confirm, then `pw snapshot` again to verify you are
   past the wall before doing anything else.

Because the profile persists, this should happen at most once per site per machine.

### Red flags — you are about to break things if you

- use a custom session name (`-s=anything`);
- call `playwright-cli` directly instead of `pw`;
- open a fresh browser for each URL instead of reusing the running session;
- call `pw end` in the middle of a task;
- proceed after a snapshot shows "Sign in", "Log in", "Enter password",
  "Verify", "two-factor", "authenticator", or an Okta / SSO / Microsoft /
  Google login screen;
- type a password or 2FA code yourself (unless the human explicitly asked you to);
- report success or "extracted data" from a page that was actually an auth wall.

## Switching accounts or clearing a bad login

`pw forget` closes the browser, kills any lingering Chrome processes tied to the
pw profile, and deletes the saved profile and auth state. The next `pw open`
starts logged-out. For a one-off session that saves nothing, prefix with
`PW_EPHEMERAL=1`.

## Starting a fresh browser session

When opening a browser for the first time in a task, run from the scratch dir so
playwright-cli uses it as the workspace root and artifacts don't litter the repo:

```bash
cd /tmp/pw-cli && pw open https://example.com
```

Subsequent commands (`pw snapshot`, `pw click`, `pw end`, etc.) can be run from
any directory — only the initial `pw open` needs the scratch dir as cwd.

## Common commands

```bash
cd /tmp/pw-cli && pw open https://example.com   # initial open — run from scratch dir
pw open https://other.com   # navigate existing session (any cwd)
pw snapshot                     # structured page snapshot with element refs
pw click e15                    # act on a ref from the snapshot
pw fill e5 "user@example.com" --submit
pw type "search text"
pw screenshot --filename=shot.png
pw eval "document.title"
pw --raw eval "JSON.stringify(...)"   # clean output for piping
pw status                       # what is running
pw end                          # close browser when task is done (saves login state)
pw fresh https://example.com    # force a NEW browser (rare — clean slate only)
pw forget                       # clear saved login + kill profile browsers
pw nuke                         # kill everything + wipe scratch dir
```

Full command surface: `pw --help` (it appends `playwright-cli --help`).

## Artifacts

Snapshots, screenshots, and traces go to a scratch dir outside any repo
automatically. Do not write output paths into the project tree.
