---
name: use-browser
description: Use when driving a web browser to get something done — navigating to a page, clicking, filling or submitting a form, taking a screenshot, scraping or extracting data from a page, logging into a site, or testing a web page. For agent-driven browser automation of any site. Not for shared interactive debugging of your own running app — that is cosession.
allowed-tools: Bash(pw:*)
---

# use-browser

Drive a real browser from the terminal with `pw`. ONE reusable session, a
persistent login profile, a visible (headed) window by default, and all
artifacts written outside your repos.

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

## Visible by default — pw hide / pw show

The browser opens as a normal visible window so the human can watch. Switch
modes when needed:

- `pw hide` — relaunch the browser headless (invisible) on the same profile
  and page. Navigation, snapshots, screenshots, and clicks all keep working.
  Use for long unattended background work, or when the user says the window
  is in the way. The choice persists across restarts.
- `pw show` — bring it back as a visible window, same profile and page.

Both keep logins and the current page; the relaunch takes a few seconds.

## After the human confirms login — NEVER call pw open again

When a human says "logged in" or "done" after completing an auth flow:

1. Run `pw snapshot` ONLY — do NOT call `pw open <url>` again.
2. `pw open` kills the current browser and relaunches, wiping the session the human just created.
3. If the snapshot confirms you're past the auth wall, navigate with `pw eval "location.href = 'url'"` or `pw click` — never `pw open`.
4. If the snapshot still shows a login page, tell the human and wait again.

This is the most common failure mode. Burn it in: **after login confirmed → `pw snapshot`, never `pw open`**.

## Logins and 2FA — STOP, do not push through

The browser uses a persistent on-disk profile, so a human logs in (and passes
2FA) ONCE and it sticks across launches and tasks. The first time you hit a
site's auth wall, a human has to complete it — you cannot.

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
4. **Wait** for the human to confirm, then `pw snapshot` to verify — never `pw open`.

Because the profile persists, this should happen at most once per site per
machine.

### Red flags — you are about to break things if you

- use a custom session name (`-s=anything`);
- call `playwright-cli` directly instead of `pw`;
- open a fresh browser for each URL instead of reusing the running session;
- call `pw end` in the middle of a task;
- **call `pw open <url>` after the human says they logged in** — snapshot first, navigate with eval or click;
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
close it, e.g.: "Done. Keep the browser window open for follow-ups, or close it
(`pw end`)?"

- **Keeping it open** means the next task reuses it instantly; login state is
  safe either way.
- **`pw end`** closes the browser cleanly; the login profile persists on disk.
- Never just walk away from a task leaving the window in a state the user
  didn't ask for.

**NEVER call `pw hide` at the end of a task.** `pw hide` persists headless mode
across sessions — the next `pw open` will launch invisible with no window, and
the user will see timeouts with no browser appearing. Only call `pw hide` if
the user explicitly asks for it ("hide the browser", "run headless"). If the
user hasn't asked, leave the browser visible or close it with `pw end`.

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
pw hide                         # tuck the browser away (headless background work)
pw show                         # bring the window back
pw status                       # session, mode, last used, orphan warnings
pw gc                           # reap orphaned browsers + stale locks
pw end                          # close browser when task is done (login persists)
pw fresh https://example.com    # force a NEW browser (rare — clean slate only)
pw forget                       # clear saved login + kill profile browsers
pw nuke                         # kill everything + wipe scratch dir
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
