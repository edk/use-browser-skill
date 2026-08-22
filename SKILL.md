---
name: use-browser
description: Use when driving a web browser to get something done — navigating to a page, clicking, filling or submitting a form, taking a screenshot, scraping or extracting data from a page, logging into a site, or testing a web page. For agent-driven browser automation of any site. Not for shared interactive debugging of your own running app — that is cosession.
allowed-tools: Bash(pw:*)
---

# use-browser

Drive a real browser from the terminal with `pw`. One reusable browser per agent
session, a persistent login profile, a visible (headed) window by default, and
all artifacts written outside your repos.

## The one rule

Use `pw` for all browser work. Never call `playwright-cli` directly. `pw` sets
the mode, the artifact location, the persistent profile, and the session name
for you. If `pw` is not on PATH, call it at
`~/.claude/skills/use-browser/bin/pw`.

## Session discipline: one browser per agent session

Each concurrent agent session gets its own browser and its own on-disk profile,
keyed automatically on `CLAUDE_CODE_SESSION_ID`. Your `pw` commands only ever
touch your own browser, and no other session can navigate or kill it.

This matters because the alternative silently corrupts results: with one shared
browser, another session could navigate it between your `pw open` and your next
command, and you would read a different page than the one you asked for and
report confident nonsense about it.

- Do not pass `-s=`, `--session`, or `PW_SESSION`. `pw` derives the session name
  from the session id. Overriding it either collides with another session or
  points two names at one profile, which Chromium refuses to open twice.
- Never call `playwright-cli` directly. Direct calls bypass session tracking,
  and session names resolve globally, so a raw `playwright-cli -s=pw ...` can
  attach to a different session's browser and steer it.
- `pw open <url>` navigates your existing browser. It does not open a second
  one, and it does not close and reopen the one you have — that is what raw
  `playwright-cli open` does, and `pw` exists partly to keep it away from a
  running browser. Use it for every URL, including the tenth in a row. If no
  browser is running it launches one, reaping your own stale orphans first
  (self-healing), and says so on stderr; silence means it navigated in place.
- Do not call `pw end` between steps within a task. That throws away the
  session. Only consider it when the whole task is finished (see Finishing up).
- `pw fresh <url>` is rare: only for a clean slate (switching accounts,
  corrupted state). It closes your current browser and opens a new one.
- `pw status` names the session it is reporting on. It also prints
  `playwright-cli list`, which is machine-wide, so rows for other agents'
  sessions appear there. Ignore every row except the one `pw status` names.
- `pw nuke` resets only your session. `pw nuke --all` kills every session's
  browser on the machine, including other agents'. Do not use `--all` unless
  the user asks for a machine-wide reset.

## Visible by default — pw hide / pw show

The browser opens as a normal visible window so the human can watch. Switch
modes when needed:

- `pw hide` — relaunch the browser headless (invisible) on the same profile
  and page. Navigation, snapshots, screenshots, and clicks all keep working.
  Use for long unattended background work, or when the user says the window
  is in the way. The choice persists across restarts.
- `pw show` — bring it back as a visible window, same profile and page.

Both keep logins and the current page; the relaunch takes a few seconds.

## After the human confirms login — snapshot before you navigate

When a human says "logged in" or "done" after completing an auth flow:

1. Run `pw snapshot` ONLY. Do not navigate anywhere yet.
2. A site finishes an auth flow with redirects and token exchanges of its own.
   Navigating on top of an unfinished one aborts it and drops you back at the
   login page, so let the snapshot tell you where you actually are.
3. Once the snapshot confirms you are past the auth wall, go wherever you need
   with `pw open <url>`. It navigates the browser you already have and keeps the
   login (see Session discipline).
4. If the snapshot still shows a login page, tell the human and wait again.

Burn it in: **after login confirmed → `pw snapshot` first, navigate second.**

## How long a login lasts

The browser uses a persistent on-disk profile, so a login is not lost when the
browser closes. What it survives depends on scope:

- Within your session, a login always sticks. It survives `pw end`, `pw show`,
  `pw hide`, `pw fresh`, and a resume of the same session. Log in once per site
  per session, not once per command.
- A brand-new session starts from the golden profile if one exists, inheriting
  those saved logins. With no golden profile it starts logged out.
- `pw promote` saves your session's logins as the golden profile for future
  sessions. Run it after a human has logged in and the task is done:
  `pw end` first (promote refuses to copy a live profile, which would corrupt
  the cookie database), then `pw promote`.
- Leave the browser open about a minute after a login before running `pw end`.
  Chromium flushes cookies to disk on a roughly 30 second timer and Playwright
  kills the browser on teardown, so closing immediately after logging in loses
  the login. `pw promote` warns when it copies a profile with no stored cookies.

So the cost is a login per new session that needs one, dropping to zero for
sites already captured in the golden profile. It is never a login per command.

## Logins and 2FA: STOP, do not push through

The first time you hit a site's auth wall, a human has to complete it. You
cannot.

After `pw open` / navigation, take a `pw snapshot`. If the page is a login,
SSO, "verify it's you", 2FA, or authenticator screen instead of the content you
asked for:

1. **STOP.** Do not click through, do not type credentials or codes, do not
   assume the page loaded, do not move on to the next URL.
2. **Make sure the window is visible** — if the browser is hidden (headless),
   run `pw show` first.
3. **Hand off to the human.** Say something like: "Jira is showing a login
   screen in the browser window — please sign in there, then tell me to
   continue."
4. **Wait** for the human to confirm, then `pw snapshot` to verify before you
   navigate anywhere.

Because the profile persists, this happens at most once per site per session,
and not at all for sites already saved in the golden profile. When it does
happen, `pw promote` afterwards spares every future session the same prompt.

### Red flags: you are about to break things if you

- use a custom session name (`-s=anything`) or set `PW_SESSION`;
- call `playwright-cli` directly instead of `pw`;
- act on a `playwright-cli list` row that is not the session `pw status` names;
- run `pw nuke --all` without being asked for a machine-wide reset;
- reach for `pw fresh` or raw `playwright-cli open` to visit a URL, instead of
  plain `pw open <url>`, which reuses the browser you already have;
- call `pw end` in the middle of a task;
- run `pw promote` before the browser is closed, or seconds after a login;
- **navigate anywhere the moment the human says they logged in** — snapshot
  first, then go;
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
  profile (logins made there are lost) and it stops and relaunches the daemon
  every time, so it throws away the page and session you already had.
- **"cannot tell whether your browser is running"**: `playwright-cli list` failed
  twice, so `pw` refused to act rather than relaunch over a browser that may be
  alive and working. Re-run the same command; if it keeps happening, `pw status`.
- `pw status` names your session and profile, then shows mode, last-used time,
  and orphan warnings. The `playwright-cli list` block above that is
  machine-wide; other agents' sessions are not yours to act on.
- `pw gc` reaps your own orphaned browsers, clears your stale profile locks, and
  deletes abandoned session profiles unused for `PW_SESSION_TTL_DAYS` (7). It
  never touches a profile with a live browser, or another session's browser.
- Logged out in a fresh session when you expected not to be: no golden profile
  has been saved yet, or someone ran `pw forget`. Have the human log in, then
  `pw end` and `pw promote`.

## Finishing up — ask, don't just abandon or kill

When the whole task is done, ask the user whether to keep the browser open or
close it, e.g.: "Done. Keep the browser window open for follow-ups, or close it
(`pw end`)?"

- **Keeping it open** means the next task reuses it instantly; login state is
  safe either way.
- **`pw end`** closes the browser cleanly; the login profile persists on disk.
- Never just walk away from a task leaving the window in a state the user
  didn't ask for.

**NEVER call `pw hide` at the end of a task.** `pw hide` persists headless mode
for the rest of your session, so your next `pw open` launches invisible with no
window and the user sees timeouts with no browser appearing. (The choice is
per-session now, so it no longer leaks into other sessions, but it still ruins
the rest of yours.) Only call `pw hide` if
the user explicitly asks for it ("hide the browser", "run headless"). If the
user hasn't asked, leave the browser visible or close it with `pw end`.

## Switching accounts or clearing a bad login

`pw forget` closes your browser, kills lingering processes tied to your profile,
deletes your saved profile and auth state, and stops your session being re-seeded
from the golden profile. Your next `pw open` starts logged out. Other sessions
are unaffected, and the golden profile is kept: add `--golden` to clear that too,
which makes every future session start logged out. For a one-off run that saves
nothing, prefix with `PW_EPHEMERAL=1`.

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
pw hide                         # tuck the browser away (headless background work)
pw show                         # bring the window back
pw status                       # your session name + profile, mode, last used, orphans
pw gc                           # reap your orphans + stale locks + old session profiles
pw end                          # close browser when task is done (login persists)
pw fresh https://example.com    # force a NEW browser (rare, clean slate only)
pw promote                      # after 'pw end': save logins for future sessions
pw forget                       # clear this session's login (--golden clears the seed)
pw nuke                         # reset THIS session (--all resets every session)
```

Full command surface: `pw --help` (it appends `playwright-cli --help`).

## pw eval — JS syntax rules

`pw eval` runs in a restricted evaluator that does not support ES6+ syntax. Common failures:

- `const`, `let`, arrow functions (`=>`), template literals, and trailing semicolons in multi-expression strings all cause `SyntaxError`.
- `JSON.stringify(...)` with multi-line arrow-function callbacks is the most common pattern that breaks.

Solutions:

- Use `function` keyword instead of arrow functions.
- Use `var` instead of `const`/`let`.
- For multi-line JS, use `pw run-code` (runs a full Playwright code snippet) instead of `pw eval`.
- When building selector queries that map or filter results, keep it as a single chained expression using `function(){}` callbacks throughout.

Working example:

```bash
# GOOD — uses function keyword, no const/let
pw --raw eval "JSON.stringify([...document.querySelectorAll('a')].map(function(a){return {text: a.innerText.trim(), href: a.href}}).filter(function(l){return l.text.length > 5}).slice(0,20), null, 2)"

# BAD — arrow function causes SyntaxError
pw --raw eval "JSON.stringify([...document.querySelectorAll('a')].map(a => ({text: a.innerText, href: a.href})), null, 2)"
```

## Clicking elements — use refs, not text

When `pw click "some text"` fails with "does not match any elements", the element is likely in a shadow DOM or uses a non-standard role. The reliable workflow:

1. Take `pw screenshot --filename=shot.png` and read `${TMPDIR:-/tmp}/pw-cli/shot.png` to visually locate the element.
2. Take `pw snapshot` to get element refs (e.g. `e42`).
3. Use `pw click e42` with the ref, or use `pw --raw eval` with a DOM query to `.click()` it directly.

Do not retry `pw click "text"` with slight text variations — fall back to ref or eval click immediately.

## Artifacts

`pw` changes its working directory to `${TMPDIR:-/tmp}/pw-cli` before every command, so all artifacts land there regardless of where you run `pw` from. A relative `--filename=shot.png` becomes `/tmp/pw-cli/shot.png` on Linux and `$TMPDIR/pw-cli/shot.png` on macOS.

To read a screenshot back after taking it:

```bash
pw screenshot --filename=shot.png
# then read it with the absolute path:
find "${TMPDIR:-/tmp}/pw-cli" -name "shot.png" | tail -1
# or just construct it directly:
Read: ${TMPDIR:-/tmp}/pw-cli/shot.png
```

Do not try to read screenshots from the current working directory or the skill directory — they will not be there. Do not write `--filename` paths into the project tree.
