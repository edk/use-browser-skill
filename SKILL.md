---
name: use-browser
description: Use when driving a web browser to get something done — navigating to a page, clicking, filling or submitting a form, taking a screenshot, scraping or extracting data from a page, logging into a site, or testing a web page. For agent-driven browser automation of any site. Not for shared interactive debugging of your own running app — that is cosession.
allowed-tools: Bash(pw:*)
---

# use-browser

Drive a real browser from the terminal with `pw`. ONE reusable session, a
persistent login profile, headless (invisible) by default, and all artifacts
written outside your repos.

## The one rule

Use `pw` for all browser work. Never call `playwright-cli` directly — `pw`
sets the mode, the artifact location, the persistent profile, and the shared
session for you. If `pw` is not on PATH, call it at
`~/.claude/skills/use-browser/bin/pw`.

## Session discipline — one browser, no orphans

There is ONE browser shared across tasks. Breaking this discipline leaves
abandoned browsers running.

- **Never use a custom session name.** Do not pass `-s=`, `--session`, or any
  other flag that would create a named session other than the default `pw`.
  Every `pw` command uses the same session automatically.
- **Never call `playwright-cli` directly.** Only ever call `pw`. Direct
  `playwright-cli` calls bypass session tracking and can spawn unmanaged browsers.
- **`pw open <url>` navigates the existing browser.** It does not open a second
  one. To visit another URL, just run `pw open <url>` again. If no browser is
  running it launches one, reaping any stale orphans first (self-healing).
- **Do NOT call `pw end` between steps within a task** — that throws away the
  session. Only consider it when the whole task is finished (see Finishing up).
- **`pw fresh <url>` is rare** — only for a genuinely clean slate (switching
  accounts, corrupted state). It closes the current browser and opens a new one.

## Invisible by default — pw show / pw hide

The browser runs headless: no window appears, but navigation, snapshots,
screenshots, and clicks all work normally. Switch modes when needed:

- `pw show` — relaunch the browser visibly on the same profile and page.
  Use when the human must see or act on the page (login walls, 2FA, watching
  a flow), or asks to watch. The choice persists across restarts.
- `pw hide` — return it to invisible, same profile and page.

Both keep logins and the current page; the relaunch takes a few seconds.

## Logins and 2FA — STOP, do not push through

The browser uses a persistent on-disk profile, so a human logs in (and passes
2FA) ONCE and it sticks across launches and tasks. The first time you hit a
site's auth wall, a human has to complete it — you cannot.

After `pw open` / navigation, take a `pw snapshot`. If the page is a login,
SSO, "verify it's you", 2FA, or authenticator screen instead of the content you
asked for:

1. **STOP.** Do not click through, do not type credentials or codes, do not
   assume the page loaded, do not move on to the next URL.
2. **Run `pw show`** so the browser window is visible.
3. **Hand off to the human.** Say something like: "Jira is showing a login
   screen — I've made the browser visible; please sign in there, then tell me
   to continue."
4. **Wait** for the human to confirm, then `pw snapshot` again to verify you
   are past the wall before doing anything else.

Because the profile persists, this should happen at most once per site per
machine.

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

## Troubleshooting — read this before improvising

- **"Browser is already in use"**: a stale orphan holds the profile. Run the
  same `pw open <url>` again (open reaps orphans), or `pw gc`. **NEVER add
  `--isolated`** — it runs on a throwaway copy of the profile and silently
  discards every login from that run.
- **Never fall back to raw `playwright-cli open`** — that uses an in-memory
  profile; logins made there are lost.
- `pw status` shows the session, mode, last-used time, and warns about orphans.
- `pw gc` reaps orphaned browsers and clears stale profile locks.

## Finishing up — ask, don't just abandon or kill

When the whole task is done, ask the user whether to keep the browser open or
close it, e.g.: "Done. Keep the browser open for follow-ups, or close it
(`pw end`)?"

- **Keeping it open is the default** and costs nothing while headless — the
  next task reuses it instantly, and login state is safe either way.
- If the browser is currently VISIBLE (`pw show` was used) and the task is
  done, at least `pw hide` it if the user wants it kept; a visible abandoned
  window is clutter.
- `pw end` closes the browser cleanly; the login profile persists on disk.

## Switching accounts or clearing a bad login

`pw forget` closes the browser, kills any lingering browser processes tied to
the pw profile, and deletes the saved profile and auth state. The next
`pw open` starts logged-out. For a one-off session that saves nothing, prefix
with `PW_EPHEMERAL=1`.

## Common commands

```bash
pw open https://example.com     # open (or reuse) the browser and navigate — any cwd
pw snapshot                     # structured page snapshot with element refs
pw click e15                    # act on a ref from the snapshot
pw fill e5 "user@example.com" --submit
pw type "search text"
pw screenshot --filename=shot.png
pw eval "document.title"
pw --raw eval "JSON.stringify(...)"   # clean output for piping
pw show                         # make the browser visible (human needs to see/act)
pw hide                         # back to invisible
pw status                       # session, mode, last used, orphan warnings
pw gc                           # reap orphaned browsers + stale locks
pw end                          # close browser when task is done (login persists)
pw fresh https://example.com    # force a NEW browser (rare — clean slate only)
pw forget                       # clear saved login + kill profile browsers
pw nuke                         # kill everything + wipe scratch dir
```

Full command surface: `pw --help` (it appends `playwright-cli --help`).

## Artifacts

Snapshots, screenshots, and traces go to a scratch dir outside any repo
automatically. Do not write output paths into the project tree.
