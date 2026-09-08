# pwx: Node port of pw for Chrome and Firefox on macOS, Ubuntu, and Windows 10

Date: 2026-09-08
Status: approved design, not yet implemented

## Purpose

`bin/pw` is an 800 line bash wrapper around Microsoft's `@playwright/cli`
(binary `playwright-cli`). It gives each Claude Code session its own browser
and on-disk profile, seeds new sessions from a golden profile, promotes a
session's logins back to golden, reaps orphaned browsers, and works around
playwright-cli's cached headless flag. It only runs Chromium on macOS.

Goal: the same tool, same command surface, running Chromium and Firefox on
macOS, Ubuntu Linux, and native Windows 10, with low maintenance.

Why a port and not a replacement: a September 2026 survey of open source
agent-browser tools (playwright-cli, Playwright MCP, chrome-devtools-mcp,
agent-browser, browser-use, Stagehand, Skyvern, Lightpanda, Steel,
Nanobrowser, Puppeteer MCP) found none that provides per-session profile
cloning and promotion. playwright-cli itself already supports Firefox
(`--browser=firefox`), native Windows (named pipes, LOCALAPPDATA paths), named
sessions, persistent profiles, and a config file. The wrapper's remaining
value is the clone and promote layer plus process lifetime, and that is what
the port keeps. Upstream issue microsoft/playwright-cli#460 (daemon lifetime
bound to an owner pid) may later remove the need for the reaper.

Why Node and not Python: playwright-cli is already an npm package, so Node is
the only runtime the user must have. npm installs a `.cmd` shim and a bash shim
together, so `pw` works from PowerShell and from the Git Bash that Claude Code
uses on Windows. Node's process and fs APIs cover the three things bash cannot
do portably: process listing, signals, atomic rename.

## Decisions already made

- Engine: playwright-cli, pinned as a dependency in the repo's package.json.
- Not published to npm or any registry. Installed from a git clone.
- Development name is `pwx` with state under `~/.cache/pwx`, so the live
  `~/.local/bin/pw` and `~/.cache/pw-cli` are untouched until cutover.
- Browser chosen per session by `--browser` or `PW_BROWSER`, remembered by the
  session, with a per-machine default in a config file. Chromium is the
  built-in default.
- One golden profile per browser. Profiles are never shared across machines
  or across browsers.
- Verification: unit tests with a stub, integration tests with real headless
  browsers, GitHub Actions matrix on ubuntu, windows, and macos, plus a manual
  headed checklist run on the user's LAN Windows 10 and Ubuntu machines.

## Section 1: layout and CLI surface

```
bin/pwx.js                 entry, arg parsing, dispatch (becomes bin/pw at cutover)
lib/config.js              state root, config file, env, defaults, per-OS paths
lib/session.js             session key, mode, last-used, seed, promote, sweep
lib/engine.js              spawn pinned playwright-cli, parse `list` and .session files
lib/procs.js               cross-platform process listing and kill
lib/browsers/chromium.js   adapter (see section 3)
lib/browsers/firefox.js    adapter, same interface
package.json               "@playwright/cli" pinned, "bin": {"pwx": "bin/pwx.js"}, node >= 20
test/unit/*.test.js        node:test against a stub playwright-cli
test/integration/*.test.js real headless browsers, local http server
test/stub/playwright-cli.js
.github/workflows/ci.yml   ubuntu, windows, macos matrix
docs/manual-verification.md
SKILL.md                   updated for --browser and the Linux and Windows notes
bin/pw, install.sh         unchanged until cutover
```

No dependencies beyond `@playwright/cli`. Node 20 or later, which playwright-cli
already requires. No build step.

Command surface is unchanged from today's `pw`. Wrapper-handled commands:
`help`, `status`, `show`, `hide`, `gc`, `promote`, `end`, `fresh`, `forget`
(alias `logout`), `nuke`, `selftest`, `open`. Every other verb (`snapshot`,
`click`, `fill`, `type`, `screenshot`, `eval`, `tab-*`, `cookie-*`, `upload`,
and anything upstream adds later) is passed through to playwright-cli with the
session name and cwd set, so new upstream commands need no wrapper change. The
`--raw` prefix passes through as today.

Additions:

- `--browser chromium|firefox` on `open` and `fresh`, or env `PW_BROWSER`.
  The session records the browser at open. Later commands use the recorded
  value. Passing a different browser to a session that already has one is an
  error whose message says to run `pwx end` first.
- `pwx config` prints the effective config and the source of each value.
  `pwx config set <key> <value>` writes the machine default. Keys: `browser`,
  `headed`, `stateDir`.
- `pwx status` gains a browser column and prints the resolved per-OS paths.
- `pwx menu`, also reached by running `pwx` with no arguments, is a numbered
  interactive picker over the commands above, prompting for a URL or browser
  where relevant. Bare `pwx` no longer prints help. `pwx help` still does.

Install during development: `npm install` in the repo, then symlink or copy
`bin/pwx.js` to `~/.local/bin/pwx`. On Windows, `npm install -g .` in the repo
gives the `.cmd` shim without publishing. Cutover installs the same thing under
the name `pw`.

## Section 2: state model and per-OS paths

State root, chosen in order: `PW_STATE_DIR` env, `stateDir` in the config
file, default. Default is `~/.cache/pwx` during development and
`~/.cache/pw-cli` after cutover, on all three OSes. `~/.cache` is used on
Windows as well so there is one path shape and no roaming-profile surprises.

```
config.json                 machine defaults: browser, headed, stateDir
golden/chromium/            seed profile per browser
golden/firefox/
sessions/<key>/
  browser                   "chromium" or "firefox", written at open
  mode                      "headed" or "headless"
  last-used                 epoch seconds
  no-seed                   marker, same meaning as today
  profile/                  live profile for this session
profile/                    legacy shared profile when there is no session id
```

Session key: `CLAUDE_CODE_SESSION_ID` with non-alphanumerics stripped,
truncated to 12 characters, exactly as today. playwright-cli session name is
`pw-<key>`. No session id means the legacy shared session. An explicit
`PW_PROFILE_DIR` forces shared mode.

Migration of existing state: on first run against a state root whose
`golden/` contains profile files rather than browser subdirectories, the
contents are moved to `golden/chromium/`. Sessions without a `browser` file
are treated as chromium. The move is a rename and is reversible by renaming
back. This runs only at cutover, since development uses `~/.cache/pwx`.

Scratch and artifacts: `path.join(os.tmpdir(), 'pw-cli')` on all OSes. This
is playwright-cli's working directory, and the sha1 of that path keys its
daemon directory, so it must stay fixed per tool. Development uses
`os.tmpdir()/pwx` so its daemons are separate from the live tool's.

playwright-cli daemon directory, resolved by copying upstream's rule from
`playwright-core/lib/tools/cli-client/registry.js`:

- Linux: `$XDG_CACHE_HOME` or `~/.cache`
- macOS: `~/Library/Caches`
- Windows: `%LOCALAPPDATA%`, fallback `~/AppData/Local`
- then `ms-playwright/daemon/<sha1 of workspace path>/`
- override: `PWTEST_DAEMON_SESSION_DIR`

The wrapper needs this for one purpose: deleting `<session>.session` so a
headed to headless switch is honored on the next open. If the computed
directory does not exist, `status` and `selftest` report it, rather than
silently doing nothing.

Config precedence, highest first: CLI flag, env var, session record,
`config.json`, built-in default. `pwx config` prints all five columns.

Timestamps use `fs.stat` mtime, removing the BSD `stat -f` and `date -r`
dependencies. Seed and promote stage into a sibling directory and finish with
`fs.rename`, which is atomic on APFS, ext4, and NTFS.

## Section 3: browser adapters

`lib/browsers/chromium.js` and `lib/browsers/firefox.js` export one interface.
Nothing outside an adapter knows browser details.

- `name`: value for playwright-cli `--browser`. Chromium uses `chromium`,
  which resolves to Chrome for Testing and avoids the branded-Chrome replayd
  storm on macOS. Firefox uses `firefox`.
- `install()`: `playwright-cli install-browser <name>`, adding `--with-deps` on
  Linux.
- `lockFiles`: removed only after the browser is confirmed dead.
  Chromium: `SingletonLock`, `SingletonSocket`, `SingletonCookie`.
  Firefox: `.parentlock`, `lock`, and on Windows `parent.lock`.
- `pruneDirs`: excluded from seed and promote copies.
  Chromium: the current list (`Default/Cache`, `Default/Code Cache`,
  `Default/Service Worker`, `GraphiteDawnCache`, `component_crx_cache`, and
  the rest of today's `PW_PROFILE_SKIP`).
  Firefox: `cache2`, `startupCache`, `shader-cache`, `thumbnails`,
  `sessionstore-backups`, `crashes`, `minidumps`, `storage/default/*/cache`.
- `beforeLaunch(profileDir)`: Chromium rewrites `exit_type` and
  `exited_cleanly` in `Default/Preferences` using JSON in Node. Firefox
  appends `browser.sessionstore.resume_from_crash=false` and
  `browser.shell.checkDefaultBrowser=false` to `user.js`.
- `cookieCount(profileDir)`: promote's sanity check. Chromium reads
  `Default/Cookies`, Firefox reads `cookies.sqlite` table `moz_cookies`. Uses
  `node:sqlite` when available (Node 22+), otherwise falls back to a
  file-size check and says so in the output. No python3 dependency.
- `argvMatches(cmdline, profileDir)`: Chromium matches `--user-data-dir=<dir>`.
  Firefox matches `-profile <dir>` or `--profile <dir>`. Paths are normalized
  before comparison and compared case-insensitively on Windows.
- `unsafeUrl(url)`: the `*/export?format=*` refusal stays, Chromium only.

Profiles are not shared across OSes or browsers. Chromium ties cookie
encryption to the OS keychain, so a golden copied between machines would not
carry logins anyway. Each machine and browser builds its own golden.

`bin/patch-screencapture` stays a separate macOS-only optional tool. `pwx
selftest` offers it only on darwin, and the in-place edit is done in Node
rather than BSD sed.

## Section 4: process lifetime and orphan handling

`lib/procs.js` exposes `listProcesses()` returning `{pid, cmdline}` and
`kill(pids)`.

- macOS and Linux: `ps -axo pid=,args=`, accepted by BSD ps and procps.
- Windows: PowerShell `Get-CimInstance Win32_Process | Select ProcessId,
  CommandLine | ConvertTo-Json`. WMIC is not used; it is removed on current
  Windows 10 builds.

Kill: `process.kill(pid, 'SIGTERM')`, wait up to 5 seconds, then `SIGKILL`.
On Windows both map to TerminateProcess, so the wait is skipped. Windows
renderer children do not die with the parent, so on Windows every process
whose command line matches the profile path is killed, not only the parent.

Orphan definition is unchanged: a browser process on this session's profile
path with no live playwright-cli daemon for the session. Daemon liveness is
read from the `.session` file and confirmed by connecting to the daemon socket
(unix socket) or named pipe (Windows). Reaping runs in `gc`, in the stale
session sweep, and before `open` when the daemon is gone but a browser
survives, preserving the "never relaunch over a browser pw cannot see" rule.

Guards stay: `promote` refuses while any process matches the golden or the
session profile, the sweep never deletes a profile with a live process, and
`fresh` kills only the session's own browser.

Stale session TTL: mtime of `last-used`, default 7 days.

Seed race: stage into `sessions/<key>/profile.tmp-<pid>`, then rename. The
loser of the rename sees the winner's profile and continues. `gc` removes any
`profile.tmp-*` whose pid is not alive.

## Section 5: testing and CI

Unit tests in `test/unit`, node:test, no browser, under ten seconds:

- A Node stub `playwright-cli` records argv and env to JSON and fakes `list`
  and `.session` output. Tests assert exact upstream flags per command for
  both browsers.
- Session key derivation, config precedence, per-OS daemon directory
  resolution with HOME, XDG_CACHE_HOME, and LOCALAPPDATA overridden.
- Seed, promote, sweep, lock cleanup on fixture profile trees for each
  adapter, including golden migration from the flat layout.
- Process scanning with `listProcesses` mocked: Chromium and Firefox argv
  shapes, Windows path case folding.
- The menu, driven by piped stdin.

Integration tests in `test/integration`, real headless browsers, gated on
`PWX_INTEGRATION=1`:

- Local HTTP server that sets a cookie and reads it back.
- Per browser: open, set cookie, end, promote, open a second session, cookie
  present. Two concurrent sessions do not see each other's cookie. Kill the
  daemon and confirm the browser is found and reaped. Headed to headless
  switch clears the cached flag. Linux headed runs under `xvfb-run`.

CI in `.github/workflows/ci.yml`: matrix of ubuntu-latest, windows-latest,
macos-latest by Node 20 and 22. Unit tests on all. Integration on all with
`playwright-cli install-browser --with-deps` for chromium and firefox.

Manual checklist in `docs/manual-verification.md`, run on Windows 10, Ubuntu,
and macOS: install from a git clone, open headed with chromium and with
firefox, log in to a site, end, promote, open a second session and confirm
still logged in, gc, selftest. Results recorded with date and OS.

## Cutover (separate step, gated on user go-ahead)

Install as `pw`, set default state root to `~/.cache/pw-cli`, run the golden
migration, keep the bash script as `pw-legacy`, update SKILL.md and README.
Rollback is renaming two files.

## Out of scope

WebKit, npm publishing, sharing profiles across machines, a daemon of our own,
replacing full profile copies with playwright-cli `state-save`/`state-load`
(rejected: that format omits IndexedDB and service worker state, which sites
such as Google and Slack require for a logged-in session).
