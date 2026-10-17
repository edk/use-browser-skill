---
name: use-browser
description: Use when driving a web browser to get something done — navigating to a page, clicking, filling or submitting a form, taking a screenshot, scraping or extracting data from a page, logging into a site, or testing a web page. For agent-driven browser automation of any site. Not for shared interactive debugging of your own running app — that is cosession.
allowed-tools: Bash(pw:*), Bash(pwx:*)
---

# use-browser

Drive a real browser from the terminal with `pw`. One reusable browser per agent
session, a persistent login profile, a visible (headed) window by default, and
all artifacts written outside your repos.

## The one rule

Use `pw` for all browser work. Never call `playwright-cli` directly. On a
machine mid-migration to the Node port, the same tool is also installed as
`pwx`; everything below applies verbatim to it, so read `pw` as "whichever of
the two the user is running". Attached mode (below) exists only in `pwx`. `pw` sets
the mode, the artifact location, the persistent profile, and the session name
for you. If `pw` is not on PATH, call it at
`~/.claude/skills/use-browser/bin/pw`.

## Cost discipline: never snapshot a page you can read another way

A full `pw snapshot` costs 12,000 to 145,000 tokens. Measured on this machine:
one Wikipedia snapshot is 135,872 tokens, about 68% of a 200k context window. A
four-command task (open, snapshot, click, snapshot) measured 160,905 tokens, of
which 160,684 were the two snapshots. The same task done with the verbs below
cost 294 tokens. Treat `pw snapshot` with no arguments as a last resort.

The browser is never the slow part: no verb exceeds 4.5 seconds and `snapshot`
is the fastest of them. What costs you is tokens and round trips, so the goal is
fewer calls returning less, not faster calls.

In order of preference:

1. **Collapse a known flow into one `pw run-code`.** It takes an async function
   with the full Playwright `page` API and returns JSON. One call can navigate,
   fill, click, wait and extract. Measured: 6 calls and 8,864 tokens became 1
   call and 105 tokens.

   ```bash
   pw run-code 'async page => {
     await page.goto("https://news.ycombinator.com/");
     return await page.locator(".titleline > a").evaluateAll(
       els => els.slice(0,5).map(e => ({t: e.textContent, h: e.href})));
   }'
   ```

   `expect` is NOT in scope inside `run-code`. Wait with `locator.waitFor()`,
   `page.waitForURL()`, `page.waitForResponse()`, `page.waitForFunction()`. A
   `run-code` that throws loses all its work, so use it for pages you already
   understand, not for exploring. Multi-line shell quoting is the practical
   hazard; `--filename=script.js` avoids it.

2. **Find the one element you need, do not snapshot the page to look for it.**
   `pw find "<text>"` returns only matching nodes with surrounding context and
   working refs. Measured on a GitHub pull request: `snapshot` 75,738 bytes,
   `find "Files changed"` 791 bytes, and the ref it returned clicked correctly.
   `find` builds the full tree internally, so it saves tokens, not time.

3. **Read the file link an action already gave you.** `pw open` and `pw click`
   return about 120 tokens: the page URL, the title, and a link to a file
   holding the complete ref-annotated tree. Do not call `pw snapshot` afterwards
   for a copy of what you already have. Grep that file instead.

4. **Orient with `--depth` before drilling.** `pw snapshot --depth 5` cuts output
   96 to 98%. On Wikipedia: `--depth 3` 833 bytes, `--depth 5` 6,805 bytes, full
   138 KB. Use it to learn a page's shape, then `find` the part you want.

5. **Read content with `eval`, never with a snapshot.** Wikipedia: full snapshot
   138,038 bytes, the equivalent `eval` 168 bytes. Make extraction
   self-checking: return the data plus a two-row sample plus a count, and throw
   when the shape check fails, because a wrong column index returns plausible
   garbage silently.

6. **Read the JSON a console renders from.** Most SaaS dashboards fetch their
   data. `pw requests --filter "/api/"` then `pw --raw response-body <n>`, or
   `page.waitForResponse(...)` raced against the click inside `run-code`. Same
   token cost as scraping the DOM, but it skips pagination, virtual scrolling
   and truncated cells, and values arrive typed. The index is the global request
   number, not the filtered position. `requests` clears on page load, so capture
   before navigating away, and be aware session tokens can appear in
   `request-headers` output.

7. **Chain calls with `&&` in one Bash call.** The unit of cost is the tool
   call, not the process. Past three or four steps, prefer one `run-code`,
   because process startup adds up (2,676 ms across 6 processes against 874 ms
   for one `run-code`).

### Target by role locator, not by ref, when chaining

Refs die on the navigation a click causes, so a chained command cannot reuse one.
Every action verb accepts a locator instead:

```bash
pw click "getByRole('button', { name: 'Sign in' })"
```

`pw generate-locator <ref>` promotes a ref you already have into a durable
locator. Role locators break under localisation where CSS survives, and the
reverse; duplicate accessible names cause strict-mode violations.

### Ref lifetime

Refs are stable identities within one page, not positions: inserting rows does
not renumber existing refs. Two things invalidate them.

- Navigating. The `fN` prefix is the document generation.
- A PARTIAL snapshot that excludes the element. `pw snapshot --depth 5` and
  `pw snapshot <selector>` register only what they print, so refs seen before
  them stop resolving.

`find` does not do this: it builds a full-page snapshot internally and registers
every ref before filtering the output. So `find` is both safe to use mid-task and
the repair when a scoped snapshot has invalidated a ref you still need.

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

## Attached mode: the browser is the user's own, and it is shared

Some sites (Cloudflare-protected ones such as ChatGPT and Twilio) refuse any
browser Playwright launched, including real Chrome. For those the user attaches
`pw` to the Chrome they already have running, through the Playwright Chrome
extension. Run `pw status` before your first action: if it says ATTACHED, the
rules below replace the session-discipline rules above.

- The browser is the user's, with every account they are signed into. `pw` does
  not own it and must never close, kill, or reset it.
- The connection is SHARED. It has one fixed name and every Claude session joins
  the same one, so another session may be working in that browser right now.
- `pw attach` is safe to re-run and does not disturb anything. If the shared
  connection is already up it joins it, opens no tab, and says "no new
  connection was opened". Only a cold attach, with no connection anywhere,
  opens a connect tab for the user to approve. It never drops or hides tabs.
- **Never run `pw detach`.** It disconnects every session, not just yours.
  Disconnecting is the user's decision. `pw end` is deliberately inert while
  attached, so the ordinary "close when done" habit cannot break anyone.
- `pw fresh`, `pw promote`, `pw forget`, `pw nuke`, `pw show`, and `pw hide` all
  refuse while attached. Do not try to work around a refusal.
- Only tabs in Chrome's "Playwright" tab group are visible to automation. The
  user's other tabs are not hidden by anything `pw` did; they were never in
  scope. `pw tab-list` shows the whole of what you can reach, and `pw tab-select`
  can only pick from that same list, so neither one can get you to a tab outside
  the group. Do not tell the user otherwise.
- Two things put a tab in the group: the user drags it in, or automation opened
  it. A tab you open with `pw open <url>` or `pw tab-new <url>` joins
  automatically. So when the user names a site, open it yourself rather than
  asking them to drag a tab over. Cookies are shared across the whole browser
  profile, so a site they are logged into is still logged in on your tab.
- `pw open <url>` navigates the current tab, which in a browser that is not
  yours may be something the user was reading. Work in your own tab instead:
  `pw tab-new <url>` to open one, `pw tab-select <n>` to switch between tabs you
  can see, `pw tab-close <n>` to clean up when done. Leave tabs you did not
  open alone, and never drag or ungroup on the user's behalf.
- Finishing up: leave the connection up and say so. Do not offer to close the
  browser or detach.

## Browser choice: chromium or firefox

`pw` drives Chromium by default. Pass `--browser firefox` on `pw open` (or
`pw fresh`), or set the environment variable `PW_BROWSER=firefox`, to use
Firefox instead. Neither flag names a running browser: both only choose
what a new session launches.

- One browser per session. The first `pw open` in a session records the
  browser it launched. `pw open`, `pw fresh`, and `pw promote` refuse if a
  later `--browser` or `PW_BROWSER` names a different browser than the one
  recorded, telling you to switch first (see below); they will not
  silently act on a profile built for the other browser. Every other
  command does not carry this guard, so do not pass `--browser` or set
  `PW_BROWSER` on them at all once a session has a recorded browser: it
  will not switch anything, and a mismatched value just fails to match
  the profile and running browser that command is actually looking at.
  Simplest: pass `--browser` only on a session's first `pw open`, never
  again after that.
- Switching a session to the other browser needs a clean slate: `pw end`,
  then `pw forget`, then open again with the new `--browser` value.
- Golden profiles are per browser and per machine. `pw promote` saves this
  session's logins into a golden profile scoped to the browser you were
  using; a Chromium golden profile never seeds a Firefox session, or the
  reverse. Golden profiles are also never shared between machines: each
  machine builds its own, for each browser it uses.

## Visible by default — pw hide / pw show

The browser opens as a normal visible window so the human can watch. Switch
modes when needed:

- `pw hide` — relaunch the browser headless (invisible) on the same profile
  and page. Navigation, snapshots, screenshots, and clicks all keep working.
  Use for long unattended background work, or when the user says the window
  is in the way. The choice persists across restarts.
- `pw show` — bring it back as a visible window, same profile and page.

Both keep logins and the current page; the relaunch takes a few seconds.

## After the human confirms login — check where you are before you navigate

When a human says "logged in" or "done" after completing an auth flow:

1. Check where you actually landed. Do not navigate anywhere yet. A site
   finishes an auth flow with redirects and token exchanges of its own, and
   navigating on top of an unfinished one aborts it and drops you back at the
   login page.
2. Check cheaply, not with a full snapshot:

   ```bash
   pw --raw eval "document.title + ' | ' + location.href"
   ```

   The URL and title answer this on their own most of the time. If the URL is
   ambiguous, `pw find "Sign in"` tells you whether a login control is still on
   the page, for a few hundred bytes.
3. Once you are past the auth wall, go where you need with `pw open <url>`. It
   navigates the browser you already have and keeps the login.
4. If you are still on a login page, tell the human and wait again.

Burn it in: **after login confirmed → check the URL first, navigate second.**

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
- You no longer need to wait after a login before `pw end`. Chromium flushes
  cookies to disk on a roughly 30 second timer and Playwright kills the browser
  on teardown, so closing right after logging in used to lose the login. `pw`
  now captures a storage-state snapshot from the live session before every
  close and carries it through promote and seeding, so the login survives
  regardless of that timer. `pw promote` still warns if it finds neither
  stored cookies nor a snapshot.

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
- **navigate anywhere the moment the human says they logged in** — check the
  URL first, then go;
- take a full `pw snapshot` when `find`, `--depth`, `eval` or the file link an
  action already returned would answer the question (see Cost discipline);
- proceed when the page shows "Sign in", "Log in", "Enter password", "Verify",
  "two-factor", "authenticator", or an Okta / SSO / Microsoft / Google login
  screen;
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
(`pw end`)?" In attached mode, skip this: leave the connection up and say so.

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
# cheap first — see Cost discipline
pw run-code 'async page => { ... }'   # whole flow in ONE call, returns JSON
pw find "Files changed"         # just the matching nodes + refs (not the page)
pw --raw eval "document.title"  # read content without a snapshot
pw snapshot --depth 5           # orient: page shape, ~2-4% of a full snapshot
pw requests --filter "/api/"    # the JSON the page renders from
pw --raw response-body 2        # ...and its body
pw generate-locator e42         # promote a ref to a durable role locator

pw open https://example.com     # open (or reuse) the browser and navigate — any cwd
pw click e15                    # act on a ref from find/snapshot
pw click "getByRole('button', { name: 'Sign in' })"   # or a locator, survives nav
pw fill e5 "user@example.com" --submit
pw type "search text"
pw screenshot --filename=shot.png     # to SHOW the human, not to find elements
pw snapshot                     # LAST RESORT: 12k-145k tokens
pw --raw eval "JSON.stringify(...)"   # clean output for piping
pw hide                         # tuck the browser away (headless background work)
pw show                         # bring the window back
pw status                       # your session name + profile, mode, last used, orphans
pw gc                           # reap your orphans + stale locks + old session profiles
pw end                          # close browser when task is done (login persists;
                                #   inert while attached — see Attached mode)
pw fresh https://example.com    # force a NEW browser (rare, clean slate only)
pw promote                      # after 'pw end': save logins for future sessions
pw forget                       # clear this session's login (--golden clears the seed)
pw nuke                         # reset THIS session (--all resets every session)
```

Full command surface: `pw --help` (it appends `playwright-cli --help`).

`find`, `generate-locator`, `recording-start` and `recording-stop` need
`@playwright/cli` 0.1.16 or newer. If `find` reports an unknown command, the
installed engine is too old: tell the human to run
`npm i -g @playwright/cli@latest`, and fall back to `pw snapshot --depth 8` plus
`grep` on the snapshot file in the meantime.

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

## Clicking elements — find the ref, do not snapshot for it

When `pw click "some text"` fails with "does not match any elements", the element
is likely in a shadow DOM or uses a non-standard role. In order:

1. `pw find "some text"` — returns the matching nodes with working refs for a few
   hundred bytes. This is almost always enough.
2. If `find` returns nothing, try a role locator:
   `pw click "getByRole('button', { name: 'Some Text' })"`.
3. If you still cannot locate it, `pw snapshot --depth 8` to see the page's shape
   and narrow down, then `find` again within that region's wording.
4. Only as a last resort: `pw --raw eval` with a DOM query to `.click()` it.

Do not retry `pw click "text"` with slight text variations. Do not take a
screenshot to look for an element; it costs about 1,850 image tokens and `find`
answers the same question for a fraction of that. Screenshots are for showing the
human what a page looks like, not for locating elements.

## Uploading a file when `upload` is refused

In attached mode the extension relay rejects the protocol call `upload` depends on:

```
fileChooser.setFiles: Protocol error (DOM.setFileInputFiles): {"code":-32000,"message":"Not allowed"}
```

Once the native picker is open, `eval` is blocked too — every call returns `Tool
"browser_evaluate" does not handle the modal state`. Clear it with `pw press Escape`
before doing anything else.

The way through is to intercept the page's own call to `.click()` on its file input, so
the native picker never opens. Install the hook BEFORE triggering the upload:

```js
window.__f = new File([bytes], "name.csv", {type:"text/csv"});
window.__orig = HTMLInputElement.prototype.click;
HTMLInputElement.prototype.click = function(){
  if (this.type === 'file') {
    var dt = new DataTransfer(); dt.items.add(window.__f);
    this.files = dt.files;
    this.dispatchEvent(new Event('input',{bubbles:true}));
    this.dispatchEvent(new Event('change',{bubbles:true}));
    return;
  }
  return window.__orig.apply(this, arguments);
};
```

Then click the page's upload button normally. Build `bytes` from a base64 string passed
in the eval, since the page cannot read your filesystem.

Drag-and-drop injection is the fallback for pages that never create an input, such as
Google Drive's main grid. Dispatch `dragenter`, `dragover`, `drop` with a `DataTransfer`
carrying the file. Two traps: the drop has to land on the overlay the page reveals after
`dragover`, not on `[role=main]`, which on Drive is empty; and firing at several candidate
targets uploads one copy per target.

Never trust the page's own progress indicator. Google Drive's upload toast can sit at
"Starting upload..." indefinitely after the file has already landed. Confirm in a separate
tab.

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
