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

## Reuse the open session — opening a new browser is rare

There is ONE browser per task and you keep using it.

- To visit another URL, just run `pw open <url>` again. It navigates the SAME
  browser. Do NOT open a separate browser per URL.
- Do NOT run `pw end`, `pw nuke`, or `pw fresh` between URLs or steps — that
  throws away the page, and for login sites it forces re-authentication. Run
  `pw status` if you are unsure what is already open.
- `pw fresh <url>` is the ONLY way to force a brand-new browser, and it is rare —
  use it only when you genuinely need a clean slate (switching accounts,
  corrupted state). Reusing is the default.
- `pw end` only when the whole task is done.

## Logins and 2FA — STOP, do not push through

The browser uses a persistent on-disk profile, so a human logs in (and passes
2FA) ONCE and it sticks across launches and tasks. The first time you hit a
site's auth wall, a human has to complete it — you cannot.

After `pw open` / navigation, take a `pw snapshot`. If the page is a login,
SSO, "verify it's you", 2FA, or authenticator screen instead of the content you
asked for:

1. **STOP.** Do not click through, do not type credentials or codes, do not
   assume the page loaded, do not move on to the next URL.
2. **Hand off to the human.** Say something like: "Confluence is showing a
   login/2FA screen in the browser window — please sign in there, then tell me
   to continue." The browser is headed; they can see and act on it.
3. **Wait** for the human to confirm, then `pw snapshot` again to verify you are
   past the wall before doing anything else.

Because the profile persists, this happens once for a site, not once per URL.

### Red flags — you are about to break things if you

- proceed after a snapshot shows "Sign in", "Log in", "Enter password",
  "Verify", "two-factor", "authenticator", or an Okta / SSO / Microsoft /
  Google login;
- open a fresh browser for each URL instead of reusing the running session;
- type a password or 2FA code yourself (unless the human explicitly told you to);
- report success or "extracted data" from a page that was actually an auth wall.

## Switching accounts or clearing a bad login

`pw forget` closes the browser and deletes the saved profile; the next
`pw open` starts logged-out. For a one-off session that saves nothing, prefix a
command with `PW_EPHEMERAL=1`.

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
pw status                       # what is running
pw fresh https://example.com    # force a NEW browser (rare)
pw forget                       # clear saved login
```

Full command surface: `pw --help` (it appends `playwright-cli --help`).

## Artifacts

Snapshots, screenshots, and traces go to a scratch dir outside any repo
automatically. Do not write output paths into the project tree.
