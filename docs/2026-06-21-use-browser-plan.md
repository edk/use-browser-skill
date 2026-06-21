# use-browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `use-browser`: a self-contained skill whose `pw` wrapper makes the agent drive a browser headed, in one reusable session, with all artifacts written outside any repo — portable and shareable.

**Architecture:** A standalone git repo (`~/code/use-browser-skill`) symlinked into `~/.claude/skills/use-browser`. A bash wrapper `bin/pw` sets env defaults and a default session, then execs the real `playwright-cli`. A self-contained `SKILL.md` tells the agent to use `pw`. `install.sh` symlinks the skill, puts `pw` on PATH, ensures the binary, and moves the upstream `playwright-cli` skill aside. Wrapper logic is tested hermetically with a stub `playwright-cli`.

**Tech Stack:** bash, the `@playwright/cli` binary (runtime dependency, not vendored).

## Global Constraints

- bash, `set -euo pipefail`; must run on bash 3.2 (macOS default) — no associative arrays, `mapfile`, or `${var,,}`.
- Portable: macOS and Linux. No runtime dependency other than the `playwright-cli` binary.
- Enforced defaults set by the wrapper, each overridable if the caller pre-sets it: `PLAYWRIGHT_MCP_HEADLESS=false`; `PLAYWRIGHT_MCP_OUTPUT_DIR=${PW_SCRATCH_DIR:-${TMPDIR:-/tmp}/pw-cli}`.
- Default session name: `pw` (override `PW_SESSION`). Binary override: `PW_BIN`.
- Skill is self-contained: full command catalog deferred to `--help`, not duplicated.
- `install.sh` is idempotent (safe to re-run after `git pull`) and reversible (backs up what it replaces).

---

### Task 1: Test harness + wrapper foundation

Wrapper resolves the binary, sets the enforced env defaults, and passes commands through. Hermetic tests via a stub `playwright-cli` that records how it was invoked.

**Files:**
- Create: `test/stub/playwright-cli`
- Create: `test/run.sh`
- Create: `bin/pw`

**Interfaces:**
- Produces: `bin/pw` executable. Env contract: exports `PLAYWRIGHT_MCP_HEADLESS` and `PLAYWRIGHT_MCP_OUTPUT_DIR`; honors `PW_BIN`, `PW_SESSION`, `PW_SCRATCH_DIR`.
- Produces: `test/run.sh` with helpers `run_pw <args...>` (sets `$REC` record file, `$RC` exit code) and `assert_contains <file> <needle> <msg>`, `assert_not_contains`, `assert_rc <expected>`.
- Stub contract: records each call (`ARGV:` line + `ENV PLAYWRIGHT_MCP_HEADLESS=` + `ENV PLAYWRIGHT_MCP_OUTPUT_DIR=`) to `$STUB_RECORD`; prints `$STUB_SESSIONS` (with `%b` expansion) for the `list` subcommand.

- [ ] **Step 1: Write the stub `playwright-cli`**

Create `test/stub/playwright-cli`:

```bash
#!/usr/bin/env bash
# Test stub for playwright-cli. Records how it was invoked; fakes `list`.
{
  echo "ARGV: $*"
  echo "ENV PLAYWRIGHT_MCP_HEADLESS=${PLAYWRIGHT_MCP_HEADLESS:-}"
  echo "ENV PLAYWRIGHT_MCP_OUTPUT_DIR=${PLAYWRIGHT_MCP_OUTPUT_DIR:-}"
} >> "${STUB_RECORD:-/dev/null}"
case "${1:-}" in
  --help) echo "stub: playwright-cli help" ;;
  list)   printf '%b' "${STUB_SESSIONS:-}" ;;
esac
exit 0
```

- [ ] **Step 2: Write the test runner with the first test**

Create `test/run.sh`:

```bash
#!/usr/bin/env bash
# Hermetic tests for bin/pw using the stub playwright-cli.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STUB_DIR="$REPO/test/stub"
PW="$REPO/bin/pw"
PASS=0; FAIL=0

run_pw() {
  REC="$(mktemp)"
  PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" PW_SCRATCH_DIR="$(mktemp -d)" \
    "$PW" "$@" >/tmp/pw_out 2>/tmp/pw_err
  RC=$?
}

assert_contains() {
  if grep -qF "$2" "$1"; then echo "ok: $3"; PASS=$((PASS+1))
  else echo "FAIL: $3"; echo "  want: $2"; echo "  in:"; sed 's/^/    /' "$1"; FAIL=$((FAIL+1)); fi
}
assert_not_contains() {
  if grep -qF "$2" "$1"; then echo "FAIL: $3"; FAIL=$((FAIL+1))
  else echo "ok: $3"; PASS=$((PASS+1)); fi
}
assert_rc() {
  if [[ "$RC" == "$1" ]]; then echo "ok: rc=$1 ($2)"; PASS=$((PASS+1))
  else echo "FAIL: rc=$RC want $1 ($2)"; FAIL=$((FAIL+1)); fi
}

# --- Task 1: env defaults + passthrough ---
run_pw goto http://example.com
assert_contains "$REC" "ENV PLAYWRIGHT_MCP_HEADLESS=false" "goto: headed default set"
assert_contains "$REC" "ENV PLAYWRIGHT_MCP_OUTPUT_DIR=" "goto: output dir exported"
assert_contains "$REC" "goto http://example.com" "goto: command passed through"

echo "---- $PASS passed, $FAIL failed ----"
[[ "$FAIL" -eq 0 ]]
```

- [ ] **Step 3: Run the tests, verify they fail**

Run: `chmod +x test/stub/playwright-cli && bash test/run.sh`
Expected: FAIL — `bin/pw` does not exist yet (runner errors / assertions fail).

- [ ] **Step 4: Write `bin/pw` foundation**

Create `bin/pw`:

```bash
#!/usr/bin/env bash
# pw — wrapper around playwright-cli (headed, one session, artifacts out of repo).
# Targets bash 3.2 (macOS default). See SKILL.md.
set -euo pipefail

PW_BIN="${PW_BIN:-playwright-cli}"
PW_SESSION="${PW_SESSION:-pw}"
PW_SCRATCH_DIR="${PW_SCRATCH_DIR:-${TMPDIR:-/tmp}/pw-cli}"

die() { echo "pw: $*" >&2; exit 2; }

command -v "$PW_BIN" >/dev/null 2>&1 || \
  die "playwright-cli not found on PATH. Install: npm i -g @playwright/cli@latest"

export PLAYWRIGHT_MCP_HEADLESS="${PLAYWRIGHT_MCP_HEADLESS:-false}"
mkdir -p "$PW_SCRATCH_DIR" || die "cannot create scratch dir: $PW_SCRATCH_DIR"
export PLAYWRIGHT_MCP_OUTPUT_DIR="${PLAYWRIGHT_MCP_OUTPUT_DIR:-$PW_SCRATCH_DIR}"

cmd="${1:-help}"
case "$cmd" in
  *)
    exec "$PW_BIN" -s="$PW_SESSION" "$@"
    ;;
esac
```

- [ ] **Step 5: Run the tests, verify they pass**

Run: `chmod +x bin/pw && bash test/run.sh`
Expected: `3 passed, 0 failed`.

- [ ] **Step 6: Commit**

```bash
chmod +x bin/pw test/stub/playwright-cli
git add bin/pw test/run.sh test/stub/playwright-cli
git commit -m "feat: pw wrapper foundation + hermetic test harness"
```

---

### Task 2: Session injection rules

Inject `-s=pw` only for session-scoped commands. Pass global commands and caller-supplied `-s=` through untouched.

**Files:**
- Modify: `bin/pw` (the `case` block)
- Modify: `test/run.sh` (add cases)

**Interfaces:**
- Consumes: `bin/pw` from Task 1.
- Produces: global commands `list|close-all|kill-all|install|--version|-V` bypass injection; leading `-s=`/`-s` bypasses injection; everything else gets `-s=$PW_SESSION`.

- [ ] **Step 1: Add failing tests**

Append to `test/run.sh` before the summary line:

```bash
# --- Task 2: session injection ---
run_pw goto http://x
assert_contains "$REC" "-s=pw goto http://x" "default session injected"
run_pw -s=other open http://x
assert_not_contains "$REC" "-s=pw" "caller -s respected"
assert_contains "$REC" "-s=other open http://x" "caller -s passed through"
run_pw list
assert_not_contains "$REC" "-s=pw" "global 'list' not injected"
```

- [ ] **Step 2: Run, verify the new cases fail**

Run: `bash test/run.sh`
Expected: the `caller -s respected` / `global 'list' not injected` assertions FAIL (Task 1's `*` injects `-s=pw` for everything).

- [ ] **Step 3: Replace the `case` block in `bin/pw`**

Replace the `case "$cmd" in ... esac` block with:

```bash
case "$cmd" in
  list|close-all|kill-all|install|--version|-V)
    exec "$PW_BIN" "$@"
    ;;
  -s=*|-s)
    exec "$PW_BIN" "$@"
    ;;
  *)
    exec "$PW_BIN" -s="$PW_SESSION" "$@"
    ;;
esac
```

- [ ] **Step 4: Run, verify all pass**

Run: `bash test/run.sh`
Expected: all passed, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add bin/pw test/run.sh
git commit -m "feat: pw session injection (default -s=pw; bypass globals and caller -s)"
```

---

### Task 3: Wrapper verbs — status, end, nuke, help

**Files:**
- Modify: `bin/pw` (add verb branches)
- Modify: `test/run.sh`

**Interfaces:**
- Consumes: `bin/pw` from Task 2.
- Produces: `pw status` -> `playwright-cli list`; `pw end` -> `-s=pw close`; `pw nuke` -> `close-all` + `kill-all` + `rm -rf scratch`; `pw help`/`-h`/`--help` -> wrapper help then `playwright-cli --help`.

- [ ] **Step 1: Add failing tests**

Append to `test/run.sh` before the summary line:

```bash
# --- Task 3: verbs ---
run_pw status
assert_contains "$REC" "ARGV: list" "status -> list"
run_pw end
assert_contains "$REC" "-s=pw close" "end -> close session"

# nuke removes the scratch dir
NUKE_SCRATCH="$(mktemp -d)"; touch "$NUKE_SCRATCH/artifact.yml"
REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" PW_SCRATCH_DIR="$NUKE_SCRATCH" "$PW" nuke >/dev/null 2>&1
assert_contains "$REC" "ARGV: close-all" "nuke -> close-all"
assert_contains "$REC" "ARGV: kill-all" "nuke -> kill-all"
if [[ -d "$NUKE_SCRATCH" ]]; then echo "FAIL: nuke left scratch dir"; FAIL=$((FAIL+1)); else echo "ok: nuke wiped scratch"; PASS=$((PASS+1)); fi
```

- [ ] **Step 2: Run, verify fail**

Run: `bash test/run.sh`
Expected: the verb assertions FAIL (status/end/nuke currently fall through to `*` and inject `-s=pw <verb>`).

- [ ] **Step 3: Add verb branches to `bin/pw`**

Insert these branches at the top of the `case "$cmd" in` block (before the `list|...` branch):

```bash
  help|-h|--help)
    cat <<EOF
pw — browser wrapper (headed; one session '${PW_SESSION}'; artifacts in ${PW_SCRATCH_DIR})

Wrapper verbs:
  pw status     list running sessions
  pw end        close the '${PW_SESSION}' session
  pw nuke       close-all + kill-all + wipe scratch dir
  pw selftest   verify headed + no repo litter
  pw help       this help

All other commands pass through to playwright-cli, scoped to '${PW_SESSION}'.
playwright-cli's own help follows:
EOF
    "$PW_BIN" --help || true
    ;;
  status)
    exec "$PW_BIN" list
    ;;
  end)
    exec "$PW_BIN" -s="$PW_SESSION" close
    ;;
  nuke)
    "$PW_BIN" close-all >/dev/null 2>&1 || true
    "$PW_BIN" kill-all  >/dev/null 2>&1 || true
    rm -rf "$PW_SCRATCH_DIR"
    echo "pw: reset (sessions killed, scratch wiped: $PW_SCRATCH_DIR)"
    ;;
```

- [ ] **Step 4: Run, verify pass**

Run: `bash test/run.sh`
Expected: all passed, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add bin/pw test/run.sh
git commit -m "feat: pw verbs (status, end, nuke, help)"
```

---

### Task 4: Idempotent open

`pw open` reuses the existing session: if the `pw` session is already running, navigate (`goto`) when a URL is given, otherwise report it's open; only launch when nothing is running.

**Files:**
- Modify: `bin/pw`
- Modify: `test/run.sh`

**Interfaces:**
- Consumes: `bin/pw` from Task 3.
- Produces: helper `session_running` (greps `playwright-cli list` for `^[[:space:]]*-?[[:space:]]*$PW_SESSION:`); `open` branch.

- [ ] **Step 1: Add failing tests**

Append to `test/run.sh` before the summary line:

```bash
# --- Task 4: idempotent open ---
run_pw open http://x
assert_contains "$REC" "-s=pw open http://x" "open launches when nothing running"

REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" STUB_SESSIONS='- pw:\n  - headed: true\n' \
  PW_SCRATCH_DIR="$(mktemp -d)" "$PW" open http://x >/dev/null 2>&1
assert_contains "$REC" "-s=pw goto http://x" "open reuses running session via goto"
assert_not_contains "$REC" "-s=pw open" "open does not relaunch a running session"
```

- [ ] **Step 2: Run, verify fail**

Run: `bash test/run.sh`
Expected: the "reuses running session" assertions FAIL (`open` currently always passes through as `open`).

- [ ] **Step 3: Add `session_running` and the `open` branch to `bin/pw`**

Add the helper after the `export PLAYWRIGHT_MCP_OUTPUT_DIR=...` line:

```bash
session_running() {
  "$PW_BIN" list 2>/dev/null | grep -qE "^[[:space:]]*-?[[:space:]]*${PW_SESSION}:"
}
```

Add this branch to the `case` block, before the final `*)` branch:

```bash
  open)
    shift
    if session_running; then
      if [[ $# -gt 0 ]]; then
        exec "$PW_BIN" -s="$PW_SESSION" goto "$@"
      else
        echo "pw: session '${PW_SESSION}' already open"
      fi
    else
      exec "$PW_BIN" -s="$PW_SESSION" open "$@"
    fi
    ;;
```

- [ ] **Step 4: Run, verify pass**

Run: `bash test/run.sh`
Expected: all passed, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add bin/pw test/run.sh
git commit -m "feat: pw idempotent open (reuse running session)"
```

---

### Task 5: selftest verb (integration self-check)

Adds `pw selftest`, which uses the real binary and a real browser to verify headed mode and no repo litter. Not part of the hermetic suite.

**Files:**
- Modify: `bin/pw`

**Interfaces:**
- Consumes: `bin/pw` from Task 4.
- Produces: `pw selftest` — exits 0 and prints `PASS:` when headed + no `.playwright-cli/` in cwd; exits 1 and prints `FAIL:` otherwise.

- [ ] **Step 1: Add the `selftest` branch to `bin/pw`**

Add this branch to the `case` block (after `nuke`, before `list|...`):

```bash
  selftest)
    tmp="$(mktemp -d)"; rc=0
    (
      cd "$tmp"
      "$0" open about:blank >/dev/null
      if [[ -d "$tmp/.playwright-cli" ]]; then
        echo "FAIL: .playwright-cli created in working directory"; exit 1
      fi
    ) || rc=1
    if [[ $rc -eq 0 ]]; then
      if "$PW_BIN" list | grep -A3 -E "^[[:space:]]*-?[[:space:]]*${PW_SESSION}:" | grep -q "headed: true"; then :
      else echo "FAIL: session is not headed"; rc=1; fi
    fi
    "$0" end >/dev/null 2>&1 || true
    rm -rf "$tmp"
    [[ $rc -eq 0 ]] && echo "PASS: headed, single session, no repo litter (artifacts -> $PW_SCRATCH_DIR)"
    exit "$rc"
    ;;
```

- [ ] **Step 2: Hermetic regression check still green**

Run: `bash test/run.sh`
Expected: all passed, 0 failed (selftest is not exercised by the stub suite).

- [ ] **Step 3: Commit**

```bash
git add bin/pw
git commit -m "feat: pw selftest (integration check for headed + no litter)"
```

Note: a real `pw selftest` run (which opens a headed browser) happens in Task 8.

---

### Task 6: SKILL.md

**Files:**
- Create: `SKILL.md`

**Interfaces:**
- Consumes: the `pw` command from Tasks 1-5.
- Produces: the skill the agent loads. `name: use-browser`.

- [ ] **Step 1: Write `SKILL.md`**

Create `SKILL.md`:

```markdown
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
```

- [ ] **Step 2: Verify frontmatter and key rules present**

Run: `head -5 SKILL.md && grep -q "Never call .playwright-cli. directly" SKILL.md && grep -q "pw end" SKILL.md && echo OK`
Expected: frontmatter prints and `OK`.

- [ ] **Step 3: Commit**

```bash
git add SKILL.md
git commit -m "feat: use-browser SKILL.md (self-contained, pw-first)"
```

---

### Task 7: install.sh

Idempotent installer: symlink the skill, put `pw` on PATH, ensure the binary, move the upstream skill aside. Testable against a sandbox HOME.

**Files:**
- Create: `install.sh`
- Create: `test/install_test.sh`

**Interfaces:**
- Consumes: repo files from Tasks 1-6.
- Produces: `~/.claude/skills/use-browser` symlink; `~/.local/bin/pw` symlink; `~/.claude/skills/playwright-cli` moved to `playwright-cli.disabled.<ts>` if present. Honors `HOME` for sandbox testing. `INSTALL_SKIP_BIN_CHECK=1` skips the binary check.

- [ ] **Step 1: Write `install.sh`**

Create `install.sh`:

```bash
#!/usr/bin/env bash
# use-browser installer. Idempotent; safe to re-run after `git pull`.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_LINK="${HOME}/.claude/skills/use-browser"
BIN_LINK="${HOME}/.local/bin/pw"

mkdir -p "${HOME}/.claude/skills" "${HOME}/.local/bin"

link_with_backup() {
  local target="$1" linkpath="$2"
  if [[ -L "$linkpath" ]]; then
    [[ "$(readlink "$linkpath")" == "$target" ]] && { echo "  = $linkpath (already linked)"; return; }
    rm "$linkpath"
  elif [[ -e "$linkpath" ]]; then
    local backup="${linkpath}.bak.$(date +%s)"
    echo "  ~ backing up $linkpath -> $backup"; mv "$linkpath" "$backup"
  fi
  ln -s "$target" "$linkpath"; echo "  + linked $linkpath -> $target"
}

echo "Linking skill and command…"
link_with_backup "$REPO_DIR" "$SKILL_LINK"
link_with_backup "$REPO_DIR/bin/pw" "$BIN_LINK"

# Move the upstream standalone skill aside so only use-browser triggers.
UPSTREAM="${HOME}/.claude/skills/playwright-cli"
if [[ -e "$UPSTREAM" && ! -L "$UPSTREAM" ]] || [[ -L "$UPSTREAM" ]]; then
  if [[ "$(readlink "$UPSTREAM" 2>/dev/null)" != "$REPO_DIR" ]]; then
    moved="${UPSTREAM}.disabled.$(date +%s)"
    echo "  ~ moving upstream playwright-cli skill aside -> $moved"
    mv "$UPSTREAM" "$moved"
  fi
fi

# Ensure the binary exists.
if [[ "${INSTALL_SKIP_BIN_CHECK:-0}" != "1" ]]; then
  if ! command -v playwright-cli >/dev/null 2>&1; then
    echo "! playwright-cli not found. Install it with:"
    echo "    npm i -g @playwright/cli@latest"
  else
    echo "  = playwright-cli present ($(command -v playwright-cli))"
  fi
fi

case ":${PATH}:" in
  *":${HOME}/.local/bin:"*) ;;
  *) echo "! ${HOME}/.local/bin is not on PATH — add it, or call pw at $SKILL_LINK/bin/pw" ;;
esac

cat <<EOF

✓ use-browser installed.
  Verify:  pw selftest
  Note: do NOT run 'playwright-cli install --skills' — use-browser supersedes it.
EOF
```

- [ ] **Step 2: Write the sandbox-HOME test**

Create `test/install_test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX="$(mktemp -d)"; PASS=0; FAIL=0
ck() { if eval "$1"; then echo "ok: $2"; PASS=$((PASS+1)); else echo "FAIL: $2"; FAIL=$((FAIL+1)); fi; }

# pre-existing upstream skill that should be moved aside
mkdir -p "$SANDBOX/.claude/skills/playwright-cli"; touch "$SANDBOX/.claude/skills/playwright-cli/SKILL.md"

HOME="$SANDBOX" INSTALL_SKIP_BIN_CHECK=1 bash "$REPO/install.sh" >/dev/null 2>&1

ck '[[ "$(readlink "$SANDBOX/.claude/skills/use-browser")" == "$REPO" ]]' "skill symlinked"
ck '[[ "$(readlink "$SANDBOX/.local/bin/pw")" == "$REPO/bin/pw" ]]' "pw symlinked to PATH dir"
ck '[[ ! -e "$SANDBOX/.claude/skills/playwright-cli" ]]' "upstream skill moved aside"
ck 'ls "$SANDBOX"/.claude/skills/playwright-cli.disabled.* >/dev/null 2>&1' "upstream backup exists"

# idempotent re-run
HOME="$SANDBOX" INSTALL_SKIP_BIN_CHECK=1 bash "$REPO/install.sh" >/dev/null 2>&1
ck '[[ "$(readlink "$SANDBOX/.claude/skills/use-browser")" == "$REPO" ]]' "re-run keeps skill link"

rm -rf "$SANDBOX"
echo "---- $PASS passed, $FAIL failed ----"; [[ "$FAIL" -eq 0 ]]
```

- [ ] **Step 3: Run, verify pass**

Run: `chmod +x install.sh && bash test/install_test.sh`
Expected: `5 passed, 0 failed`.

- [ ] **Step 4: Commit**

```bash
git add install.sh test/install_test.sh
git commit -m "feat: idempotent installer + sandbox-HOME test"
```

---

### Task 8: README, .gitignore, real install + selftest

**Files:**
- Create: `README.md`
- Create: `.gitignore`

**Interfaces:**
- Consumes: everything from Tasks 1-7.

- [ ] **Step 1: Write `.gitignore`**

Create `.gitignore`:

```
.DS_Store
*.bak.*
```

- [ ] **Step 2: Write `README.md`**

Create `README.md`:

```markdown
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
```

- [ ] **Step 3: Commit docs**

```bash
git add README.md .gitignore
git commit -m "docs: README and .gitignore"
```

- [ ] **Step 4: Real install + hermetic suite + real selftest**

Run:
```bash
bash test/run.sh && bash test/install_test.sh
bash install.sh
pw selftest
```
Expected: both test suites pass; install reports the symlinks and that the upstream skill was moved aside; `pw selftest` opens a headed browser briefly and prints `PASS: headed, single session, no repo litter`.

- [ ] **Step 5: Confirm upstream skill removed and use-browser active**

Run: `ls -la ~/.claude/skills/ | grep -E 'use-browser|playwright-cli'`
Expected: `use-browser -> ~/code/use-browser-skill`; `playwright-cli` only as a `.disabled.<ts>` backup (no live `playwright-cli` skill).

- [ ] **Step 6: Final commit**

```bash
git add -A && git commit -m "chore: use-browser v1 installed and self-tested" || echo "nothing to commit"
```

---

## Self-Review

Spec coverage: #2 lifecycle (Tasks 2,3,4), #3 litter (Task 1 output-dir + Task 5/8 assertion), headed (Task 1), portable+shareable install (Task 7), upstream removal (Task 7), self-contained skill + persistent-profile guidance (Task 6), verification (Tasks 5,8). No gaps.

Type/name consistency: `PW_BIN`/`PW_SESSION`/`PW_SCRATCH_DIR`, `session_running`, verbs `status|end|nuke|selftest|help`, env `PLAYWRIGHT_MCP_HEADLESS`/`PLAYWRIGHT_MCP_OUTPUT_DIR` — used identically across tasks.

Placeholders: none.
