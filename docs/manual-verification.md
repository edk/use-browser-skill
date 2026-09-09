# pwx manual verification checklist

`npm test` and the gated integration suite (`PWX_INTEGRATION=1 npm run
test:integration`) cover everything that can run unattended. Two things
cannot: a real login flow against a real site, and the interactive menu,
which reads input through `readline` against a TTY. `readline`'s TTY mode
cannot be driven by a piped stdin the way the unit tests drive the menu's
non-TTY line-reading path, so no automated test opens `pwx menu` in an
actual terminal and confirms the picker prompts and dispatches correctly.
A reviewer confirmed `lib/menu.js` is correct by reading the code, not by
running it. This checklist is what closes that gap: run it by hand, once
per machine, after any change that touches session state, the browser
adapters, or the menu.

Run the steps in order on each of three machines: this Mac, an Ubuntu
machine, and a Windows 10 machine, both reachable on the local network.
Each step's Result column records the operating system, the date, and
pass or fail. A step that fails stops the run for that machine; fix or
file the problem before continuing to the next step, since later steps
assume earlier ones left the machine in the state they describe.

Pick any real site with a login page for the login steps; the same site
works for both the Chromium and Firefox passes.

`pwx` below is the command installed by `npm install -g .` (see README,
Install). On Windows that resolves to the npm-generated `pwx.cmd` shim;
run it from the same shell (PowerShell or the Git Bash that Claude Code
uses) either way, since npm puts the right shim on PATH for both.

Session isolation, and the golden-profile seeding this checklist verifies,
key off `CLAUDE_CODE_SESSION_ID`: `pwx` only seeds a new session from the
golden profile when that variable is set (see README, Where pwx state
lives). Steps below that need a real, isolated session set it explicitly
per command so the checklist works the same whether run from a plain
terminal or copy-pasted cell by cell in any order.

## Setup

| # | Command | Expect | Result (OS, date, pass/fail) |
|---|---|---|---|
| 1 | `git clone <repo-url> && cd use-browser-skill` | clone succeeds | |
| 2 | `npm install` | installs `@playwright/cli`, no errors | |
| 3 | `node node_modules/@playwright/cli/playwright-cli.js install-browser chromium --with-deps` | Chromium (Chrome for Testing) installs | |
| 4 | `node node_modules/@playwright/cli/playwright-cli.js install-browser firefox --with-deps` | Firefox installs | |
| 5 | `npm install -g .` | installs the `pwx` command on PATH | |
| 6 | `pwx selftest` | prints `PASS: <mode>, single session, <browser>, artifacts -> <dir>` | |

## Chromium: login, end, promote, a fresh session inherits it

Session `pwx-verify-1` is where you log in. Session `pwx-verify-2` is a
different, never-before-used session id: it exists only to prove that a
brand new session, not just the one you logged into, inherits the login
from the golden profile.

| # | Command | Expect | Result |
|---|---|---|---|
| 7 | `CLAUDE_CODE_SESSION_ID=pwx-verify-1 pwx open https://<login-site>` | a visible (headed) Chromium window opens and navigates | |
| 8 | Log in by hand in the window that opened | login succeeds, the site shows you as signed in | |
| 9 | `CLAUDE_CODE_SESSION_ID=pwx-verify-1 pwx end` | prints session closed, login profile kept | |
| 10 | `CLAUDE_CODE_SESSION_ID=pwx-verify-1 pwx promote` | prints logins promoted to the golden profile, with no cookie warning | |
| 11 | `CLAUDE_CODE_SESSION_ID=pwx-verify-2 pwx open https://<login-site>` | a brand new session opens already logged in, no login prompt | |
| 12 | `CLAUDE_CODE_SESSION_ID=pwx-verify-2 pwx end` | session closed | |

## Firefox: login, end, promote, a fresh session inherits it

Same shape, on Firefox, with two more never-before-used session ids so
this pass cannot reuse Chromium's profiles or golden.

| # | Command | Expect | Result |
|---|---|---|---|
| 13 | `CLAUDE_CODE_SESSION_ID=pwx-verify-3 pwx open --browser firefox https://<login-site>` | a visible Firefox window opens and navigates | |
| 14 | Log in by hand in the window that opened | login succeeds | |
| 15 | `CLAUDE_CODE_SESSION_ID=pwx-verify-3 pwx end` | session closed, login profile kept | |
| 16 | `CLAUDE_CODE_SESSION_ID=pwx-verify-3 pwx promote` | prints logins promoted to the golden profile | |
| 17 | `CLAUDE_CODE_SESSION_ID=pwx-verify-4 pwx open --browser firefox https://<login-site>` | a brand new session opens already logged in | |
| 18 | `CLAUDE_CODE_SESSION_ID=pwx-verify-4 pwx end` | session closed | |

## Status, garbage collect, selftest

| # | Command | Expect | Result |
|---|---|---|---|
| 19 | `CLAUDE_CODE_SESSION_ID=pwx-verify-4 pwx status` | prints session name, browser (firefox), profile path, golden path, daemon path, not-open state, mode, last used | |
| 20 | `pwx gc` | prints cleanup summary, exits 0 | |
| 21 | `pwx selftest` | prints `PASS: <mode>, single session, <browser>, artifacts -> <dir>` | |

## Interactive menu

Run this from a real terminal window, not through a piped command or CI:
the menu reads input through `readline`'s TTY mode, which is exactly the
mechanism that cannot be exercised by an automated test or a piped stdin,
so this step is the only verification it gets.

| # | Command | Expect | Result |
|---|---|---|---|
| 22 | `pwx` (no arguments) | prints the numbered menu (open a URL, open in Firefox, show, hide, status, snapshot, screenshot, gc, promote, end, forget, config, `q`) | |
| 23 | Type `5` and press Enter (status) | runs `pwx status` and returns to the shell | |
| 24 | Run `pwx` again, type `1`, then a URL when prompted | opens or reuses the browser and navigates to that URL | |
| 25 | Run `pwx` again, type `q` | exits with no command run | |

## Cleanup

| # | Command | Expect | Result |
|---|---|---|---|
| 26 | `pwx forget --golden` | clears this machine's Chromium golden profile | |
| 27 | `pwx forget --browser firefox --golden` | clears this machine's Firefox golden profile | |
