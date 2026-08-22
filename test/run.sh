#!/usr/bin/env bash
# Hermetic tests for bin/pw using the stub playwright-cli.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STUB_DIR="$REPO/test/stub"
PW="$REPO/bin/pw"
PASS=0; FAIL=0

# Isolate the persistent profile dir so tests never touch the real ~/.cache.
export PW_PROFILE_DIR="$(mktemp -d)/profile"

# Hermetic env: the user's session may export mode overrides (e.g. Claude Code
# settings.json injects PLAYWRIGHT_MCP_HEADLESS); tests assert pw's own defaults.
unset PLAYWRIGHT_MCP_HEADLESS PW_EPHEMERAL PW_SESSION

run_pw() {
  REC="$(mktemp)"
  PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" PW_SCRATCH_DIR="$(mktemp -d)" \
    "$PW" "$@" >/tmp/pw_out 2>/tmp/pw_err
  RC=$?
}

assert_contains() {
  if grep -qF -- "$2" "$1"; then echo "ok: $3"; PASS=$((PASS+1))
  else echo "FAIL: $3"; echo "  want: $2"; echo "  in:"; sed 's/^/    /' "$1"; FAIL=$((FAIL+1)); fi
}
assert_not_contains() {
  if grep -qF -- "$2" "$1"; then echo "FAIL: $3"; FAIL=$((FAIL+1))
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

# Mode file (set by pw hide) flips the default to headless; caller env still wins.
MODE_STATE="$(mktemp -d)"; mkdir -p "$MODE_STATE/profile"; printf 'headless\n' > "$MODE_STATE/mode"
REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" PW_PROFILE_DIR="$MODE_STATE/profile" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" goto http://m1 >/dev/null 2>&1
assert_contains "$REC" "ENV PLAYWRIGHT_MCP_HEADLESS=true" "mode file 'headless' flips default to headless"
REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" PLAYWRIGHT_MCP_HEADLESS=false PW_PROFILE_DIR="$MODE_STATE/profile" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" goto http://m2 >/dev/null 2>&1
assert_contains "$REC" "ENV PLAYWRIGHT_MCP_HEADLESS=false" "caller env overrides mode file"

# --- Task 5: selftest happy path (hermetic; stub fakes a headless session) ---
# selftest must run under its own session name: with the shared name 'pw' its
# open/close/cache-clear resolve globally and destroy a live pw session in
# another workspace (this happened).
REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" STUB_SESSIONS='### Browsers\n- pw-selftest:\n  - status: open\n  - browser-type: chrome\n  - user-data-dir: <in-memory>\n  - headed: true\n' \
  PW_SCRATCH_DIR="$(mktemp -d)" "$PW" selftest >/tmp/pw_st 2>&1
if [[ "$?" -eq 0 ]] && grep -q "PASS:" /tmp/pw_st; then echo "ok: selftest happy path exits 0/PASS"; PASS=$((PASS+1))
else echo "FAIL: selftest happy path"; sed 's/^/    /' /tmp/pw_st; FAIL=$((FAIL+1)); fi
assert_not_contains "$REC" "-s=pw open" "selftest never opens the shared 'pw' session"
assert_not_contains "$REC" "-s=pw close" "selftest never closes the shared 'pw' session"
assert_contains "$REC" "-s=pw-selftest" "selftest uses its own session name"

# --- Task 4: idempotent open ---
run_pw open http://x
assert_contains "$REC" "-s=pw open --browser chromium --persistent --profile" "open launches with persistent profile by default"
assert_contains "$REC" "http://x" "open navigates to url on launch"

REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" STUB_SESSIONS='### Browsers\n- pw:\n  - status: open\n  - browser-type: chrome\n  - user-data-dir: <in-memory>\n  - headed: true\n' \
  PW_SCRATCH_DIR="$(mktemp -d)" "$PW" open http://x >/dev/null 2>&1
assert_contains "$REC" "-s=pw goto http://x" "open reuses running session via goto"
assert_not_contains "$REC" "-s=pw open" "open does not relaunch a running session"
assert_not_contains "$REC" "--persistent" "reuse path passes no profile flags (browser already launched)"

# --- Persistence + lifecycle (login-once) ---
# Ephemeral override drops the persistent profile.
REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" PW_EPHEMERAL=1 PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" open http://e1 >/dev/null 2>&1
assert_contains "$REC" "-s=pw open --browser chromium http://e1" "ephemeral: launches in-memory"
assert_not_contains "$REC" "--persistent" "ephemeral: no --persistent flag"

# fresh: force a new browser (close, then relaunch persistent).
REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" fresh http://f1 >/dev/null 2>&1
assert_contains "$REC" "-s=pw close" "fresh: closes existing session first"
assert_contains "$REC" "-s=pw open --browser chromium --persistent --profile" "fresh: relaunches with persistent profile"
assert_contains "$REC" "http://f1" "fresh: navigates to url"

# forget: clear the saved login profile.
FORGET_PROF="$(mktemp -d)/profile"; mkdir -p "$FORGET_PROF"; touch "$FORGET_PROF/cookies"
REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" PW_PROFILE_DIR="$FORGET_PROF" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" forget >/dev/null 2>&1
assert_contains "$REC" "-s=pw close" "forget: closes session first"
if [[ -d "$FORGET_PROF" ]]; then echo "FAIL: forget left profile dir"; FAIL=$((FAIL+1)); else echo "ok: forget removed profile dir"; PASS=$((PASS+1)); fi

# nuke: kills sessions + wipes scratch but PRESERVES the login profile.
KEEP_PROF="$(mktemp -d)/profile"; mkdir -p "$KEEP_PROF"; touch "$KEEP_PROF/cookies"
NUKE2="$(mktemp -d)"
REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" PW_PROFILE_DIR="$KEEP_PROF" PW_SCRATCH_DIR="$NUKE2" \
  "$PW" nuke >/dev/null 2>&1
if [[ -d "$KEEP_PROF" ]]; then echo "ok: nuke preserved login profile"; PASS=$((PASS+1)); else echo "FAIL: nuke wiped login profile"; FAIL=$((FAIL+1)); fi

# --- Task 3: verbs ---
run_pw status
assert_contains "$REC" "ARGV: list" "status -> list"
run_pw end
assert_contains "$REC" "-s=pw close" "end -> close session"

# Plain `nuke` is scoped to this session: close-all/kill-all are machine-wide
# and would take out other sessions' browsers, and the scratch dir is shared.
NUKE_SCRATCH="$(mktemp -d)"; touch "$NUKE_SCRATCH/artifact.yml"
REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" PW_SCRATCH_DIR="$NUKE_SCRATCH" "$PW" nuke >/dev/null 2>&1
assert_not_contains "$REC" "ARGV: close-all" "nuke does NOT close-all (would hit other sessions)"
assert_not_contains "$REC" "ARGV: kill-all" "nuke does NOT kill-all (would hit other sessions)"
assert_contains "$REC" "-s=pw close" "nuke closes only its own session"
if [[ -d "$NUKE_SCRATCH" ]]; then echo "ok: nuke left shared scratch dir alone"; PASS=$((PASS+1)); else echo "FAIL: nuke wiped shared scratch dir"; FAIL=$((FAIL+1)); fi

# `nuke --all` is the explicit machine-wide escape hatch: old behaviour.
NUKE_SCRATCH="$(mktemp -d)"; touch "$NUKE_SCRATCH/artifact.yml"
REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" PW_SCRATCH_DIR="$NUKE_SCRATCH" "$PW" nuke --all >/dev/null 2>&1
assert_contains "$REC" "ARGV: close-all" "nuke --all -> close-all"
assert_contains "$REC" "ARGV: kill-all" "nuke --all -> kill-all"
if [[ -d "$NUKE_SCRATCH" ]]; then echo "FAIL: nuke --all left scratch dir"; FAIL=$((FAIL+1)); else echo "ok: nuke --all wiped scratch"; PASS=$((PASS+1)); fi

# --- Task 2: session injection ---
run_pw goto http://x
assert_contains "$REC" "-s=pw goto http://x" "default session injected"
run_pw -s=other open http://x
assert_not_contains "$REC" "-s=pw" "caller -s respected"
assert_contains "$REC" "-s=other open http://x" "caller -s passed through"
run_pw list
assert_not_contains "$REC" "-s=pw" "global 'list' not injected"

# --- Cleanup verbs must finish and exit 0 (macOS pgrep+pipefail regression) ---
# kill_profile_browsers used a pgrep pattern that matches nothing on macOS;
# under set -euo pipefail the failed pipeline aborted the whole script, so
# end/fresh/forget/nuke silently truncated with rc=1.
run_pw end
assert_rc 0 "end completes"
run_pw fresh http://rc1
assert_rc 0 "fresh completes"
FORGET2="$(mktemp -d)/profile"; mkdir -p "$FORGET2"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$(mktemp)" PW_PROFILE_DIR="$FORGET2" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" forget >/dev/null 2>&1
RC=$?
assert_rc 0 "forget completes"
NUKE3="$(mktemp -d)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$(mktemp)" PW_PROFILE_DIR="$(mktemp -d)/profile" PW_SCRATCH_DIR="$NUKE3" \
  "$PW" nuke >/dev/null 2>&1
RC=$?
assert_rc 0 "nuke completes"

# --- end: kills processes holding the profile and removes Singleton locks ---
CLEAN_PROF="$(mktemp -d)/profile"; mkdir -p "$CLEAN_PROF"
touch "$CLEAN_PROF/SingletonLock" "$CLEAN_PROF/SingletonSocket" "$CLEAN_PROF/SingletonCookie"
bash -c 'sleep 300; true' "--user-data-dir=$CLEAN_PROF" >/dev/null 2>&1 &
ORPHAN_PID=$!
PATH="$STUB_DIR:$PATH" STUB_RECORD="$(mktemp)" PW_PROFILE_DIR="$CLEAN_PROF" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" end >/dev/null 2>&1
RC=$?
assert_rc 0 "end with orphan completes"
sleep 0.5
if kill -0 "$ORPHAN_PID" 2>/dev/null; then
  echo "FAIL: end left orphan process holding the profile"; kill -9 "$ORPHAN_PID" 2>/dev/null; FAIL=$((FAIL+1))
else echo "ok: end killed process holding the profile"; PASS=$((PASS+1)); fi
wait "$ORPHAN_PID" 2>/dev/null
if [[ -e "$CLEAN_PROF/SingletonLock" || -e "$CLEAN_PROF/SingletonSocket" || -e "$CLEAN_PROF/SingletonCookie" ]]; then
  echo "FAIL: end left Singleton lock files"; FAIL=$((FAIL+1))
else echo "ok: end removed Singleton lock files"; PASS=$((PASS+1)); fi

# --- show / hide: relaunch in the other mode, preserving profile and URL ---
SH_STATE="$(mktemp -d)"; mkdir -p "$SH_STATE/profile"
REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" PW_PROFILE_DIR="$SH_STATE/profile" PW_SCRATCH_DIR="$(mktemp -d)" \
  STUB_SESSIONS='### Browsers\n- pw:\n  - status: open\n  - browser-type: chrome\n  - user-data-dir: x\n  - headed: false\n' \
  STUB_EVAL="https://example.com/page" \
  "$PW" show >/dev/null 2>&1
RC=$?
assert_rc 0 "show completes"
assert_contains "$REC" "-s=pw close" "show: closes headless session"
assert_contains "$REC" "-s=pw open --browser chromium --persistent --profile" "show: relaunches persistent"
assert_contains "$REC" "https://example.com/page" "show: restores current URL"
assert_contains "$REC" "ENV PLAYWRIGHT_MCP_HEADLESS=false" "show: relaunch is headed"
if [[ "$(cat "$SH_STATE/mode" 2>/dev/null)" == "headed" ]]; then echo "ok: show persists headed mode"; PASS=$((PASS+1))
else echo "FAIL: show did not persist headed mode"; FAIL=$((FAIL+1)); fi

# show is a no-op when the session is already headed.
REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" PW_PROFILE_DIR="$SH_STATE/profile" PW_SCRATCH_DIR="$(mktemp -d)" \
  STUB_SESSIONS='### Browsers\n- pw:\n  - status: open\n  - browser-type: chrome\n  - user-data-dir: x\n  - headed: true\n' \
  "$PW" show >/dev/null 2>&1
assert_not_contains "$REC" "-s=pw close" "show: already headed -> no relaunch"

# hide: relaunch headless, mode file removed.
REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" PW_PROFILE_DIR="$SH_STATE/profile" PW_SCRATCH_DIR="$(mktemp -d)" \
  STUB_SESSIONS='### Browsers\n- pw:\n  - status: open\n  - browser-type: chrome\n  - user-data-dir: x\n  - headed: true\n' \
  STUB_EVAL="https://example.com/page" \
  "$PW" hide >/dev/null 2>&1
RC=$?
assert_rc 0 "hide completes"
assert_contains "$REC" "-s=pw close" "hide: closes headed session"
assert_contains "$REC" "ENV PLAYWRIGHT_MCP_HEADLESS=true" "hide: relaunch is headless"
assert_contains "$REC" "https://example.com/page" "hide: restores current URL"
if [[ "$(cat "$SH_STATE/mode" 2>/dev/null)" == "headless" ]]; then echo "ok: hide persists headless mode"; PASS=$((PASS+1))
else echo "FAIL: hide did not persist headless mode"; FAIL=$((FAIL+1)); fi

# --- gc: reaps orphans when no session is running ---
GC_PROF="$(mktemp -d)/profile"; mkdir -p "$GC_PROF"
bash -c 'sleep 300; true' "--user-data-dir=$GC_PROF" >/dev/null 2>&1 &
GC_PID=$!
PATH="$STUB_DIR:$PATH" STUB_RECORD="$(mktemp)" PW_PROFILE_DIR="$GC_PROF" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" gc >/dev/null 2>&1
RC=$?
assert_rc 0 "gc completes"
sleep 0.5
if kill -0 "$GC_PID" 2>/dev/null; then
  echo "FAIL: gc left orphan"; kill -9 "$GC_PID" 2>/dev/null; FAIL=$((FAIL+1))
else echo "ok: gc reaped orphan"; PASS=$((PASS+1)); fi
wait "$GC_PID" 2>/dev/null

# --- status: warns about orphans when no session is running ---
ST_PROF="$(mktemp -d)/profile"; mkdir -p "$ST_PROF"
bash -c 'sleep 300; true' "--user-data-dir=$ST_PROF" >/dev/null 2>&1 &
ST_PID=$!
PATH="$STUB_DIR:$PATH" STUB_RECORD="$(mktemp)" PW_PROFILE_DIR="$ST_PROF" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" status >/tmp/pw_status_out 2>&1
assert_contains /tmp/pw_status_out "orphan" "status: reports orphaned browser"
kill "$ST_PID" 2>/dev/null; wait "$ST_PID" 2>/dev/null

# --- clear_session_cache: never deletes a session record with a live socket ---
# The daemon dir is global across workspaces; a pw.session whose socket is
# still alive belongs to ANOTHER workspace's running session. Only stale
# records (socket gone) may be removed before a fresh launch.
FAKEHOME="$(mktemp -d)"
DAEMON="$FAKEHOME/Library/Caches/ms-playwright/daemon"
mkdir -p "$DAEMON/ctxlive" "$DAEMON/ctxstale"
LIVESOCK="$(mktemp)"
printf '{"socketPath":"%s"}' "$LIVESOCK" > "$DAEMON/ctxlive/pw.session"
printf '{"socketPath":"/nonexistent/dead.sock"}' > "$DAEMON/ctxstale/pw.session"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$(mktemp)" HOME="$FAKEHOME" \
  PW_PROFILE_DIR="$(mktemp -d)/profile" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" open http://cache1 >/dev/null 2>&1
if [[ -e "$DAEMON/ctxlive/pw.session" ]]; then echo "ok: live-socket session record preserved"; PASS=$((PASS+1))
else echo "FAIL: cache clear deleted a live session record"; FAIL=$((FAIL+1)); fi
if [[ -e "$DAEMON/ctxstale/pw.session" ]]; then echo "FAIL: stale session record not cleared"; FAIL=$((FAIL+1))
else echo "ok: stale session record cleared"; PASS=$((PASS+1)); fi

# --- open: self-heals by reaping an orphan before a fresh launch ---
# If the registry says no session but a Chrome still holds the profile, the
# relaunch dies with "Browser is already in use". open must reap it first.
HEAL_PROF="$(mktemp -d)/profile"; mkdir -p "$HEAL_PROF"
bash -c 'sleep 300; true' "--user-data-dir=$HEAL_PROF" >/dev/null 2>&1 &
HEAL_PID=$!
REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" PW_PROFILE_DIR="$HEAL_PROF" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" open http://h1 >/dev/null 2>&1
assert_contains "$REC" "-s=pw open --browser chromium --persistent --profile" "open with orphan still launches"
sleep 0.5
if kill -0 "$HEAL_PID" 2>/dev/null; then
  echo "FAIL: open left orphan holding the profile"; kill -9 "$HEAL_PID" 2>/dev/null; FAIL=$((FAIL+1))
else echo "ok: open reaped orphan before launching"; PASS=$((PASS+1)); fi
wait "$HEAL_PID" 2>/dev/null

# --- open: never destroys a browser it cannot see ---
# Deciding the session is closed is what licenses open to KILL whatever Chrome
# still holds the profile. A `playwright-cli list` that failed to run looks
# exactly like one that found nothing, so reading a failed list as "closed"
# reaped a live browser mid-task — and with it any login whose cookies Chromium
# had not yet flushed. When the state cannot be read, open must refuse.
BLIND_PROF="$(mktemp -d)/profile"; mkdir -p "$BLIND_PROF"
bash -c 'sleep 300; true' "--user-data-dir=$BLIND_PROF" >/dev/null 2>&1 &
BLIND_PID=$!
REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" STUB_LIST_RC=3 \
  PW_PROFILE_DIR="$BLIND_PROF" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" open http://blind >/tmp/pw_out 2>/tmp/pw_err
RC=$?
assert_rc 2 "open refuses when the session state cannot be read"
assert_not_contains "$REC" "-s=pw open --browser" "open does not relaunch on an unreadable list"
assert_not_contains "$REC" "-s=pw goto" "open does not navigate a session it cannot see"
assert_contains /tmp/pw_err "cannot tell" "open says why it refused"
if kill -0 "$BLIND_PID" 2>/dev/null; then
  echo "ok: open left the live browser alone when list failed"; PASS=$((PASS+1))
else echo "FAIL: open killed a browser it could not see"; FAIL=$((FAIL+1)); fi
kill -9 "$BLIND_PID" 2>/dev/null; wait "$BLIND_PID" 2>/dev/null

# A single failed list is a daemon caught mid-restart, not a dead session: one
# retry must recover it and take the reuse path.
REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" STUB_LIST_FAIL_ONCE="$(mktemp -u)" \
  STUB_SESSIONS='### Browsers\n- pw:\n  - status: open\n  - browser-type: chrome\n  - user-data-dir: <in-memory>\n  - headed: true\n' \
  PW_PROFILE_DIR="$(mktemp -d)/profile" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" open http://retry >/dev/null 2>&1
assert_contains "$REC" "-s=pw goto http://retry" "open retries a failed list and then reuses"
assert_not_contains "$REC" "-s=pw open --browser" "open does not relaunch after a recovered list"

# gc makes the same kill decision, so it needs the same guard.
GCB_PROF="$(mktemp -d)/profile"; mkdir -p "$GCB_PROF"
bash -c 'sleep 300; true' "--user-data-dir=$GCB_PROF" >/dev/null 2>&1 &
GCB_PID=$!
PATH="$STUB_DIR:$PATH" STUB_RECORD="$(mktemp)" STUB_LIST_RC=3 \
  PW_PROFILE_DIR="$GCB_PROF" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" gc >/dev/null 2>&1
if kill -0 "$GCB_PID" 2>/dev/null; then
  echo "ok: gc left the live browser alone when list failed"; PASS=$((PASS+1))
else echo "FAIL: gc killed a browser it could not see"; FAIL=$((FAIL+1)); fi
kill -9 "$GCB_PID" 2>/dev/null; wait "$GCB_PID" 2>/dev/null

# --- per-session isolation: name + profile derivation ---
# Every case below runs WITHOUT the suite-wide PW_PROFILE_DIR export, because
# an explicit profile is itself the opt-out from isolation.
ISO_CACHE="$(mktemp -d)"
iso_help() { # $1 = session id ('' for none); prints pw's first help line
  if [[ -n "$1" ]]; then
    env -u PW_PROFILE_DIR -u PW_SESSION PATH="$STUB_DIR:$PATH" \
      CLAUDE_CODE_SESSION_ID="$1" PW_CACHE_DIR="$ISO_CACHE" PW_SCRATCH_DIR="$(mktemp -d)" \
      "$PW" help 2>/dev/null | head -1
  else
    env -u PW_PROFILE_DIR -u PW_SESSION -u CLAUDE_CODE_SESSION_ID PATH="$STUB_DIR:$PATH" \
      PW_CACHE_DIR="$ISO_CACHE" PW_SCRATCH_DIR="$(mktemp -d)" \
      "$PW" help 2>/dev/null | head -1
  fi
}
assert_line() { # haystack needle label
  if printf '%s' "$1" | grep -qF -- "$2"; then echo "ok: $3"; PASS=$((PASS+1))
  else echo "FAIL: $3"; echo "  want: $2"; echo "  got:  $1"; FAIL=$((FAIL+1)); fi
}

H_A="$(iso_help 'aaaaaaaa-1111-2222-3333-444444444444')"
H_B="$(iso_help 'bbbbbbbb-1111-2222-3333-444444444444')"
H_N="$(iso_help '')"
assert_line "$H_A" "session 'pw-aaaaaaaa1111'" "session id A -> its own session name"
assert_line "$H_B" "session 'pw-bbbbbbbb1111'" "session id B -> a different session name"
assert_line "$H_A" "isolated to this agent session" "session id -> reported as isolated"
assert_line "$H_N" "session 'pw'" "no session id -> legacy shared session name"
assert_line "$H_N" "shared" "no session id -> reported as shared"

# The profile must be keyed on the session too, or two windows fight one
# userDataDir and Chromium refuses the second launch.
REC="$(mktemp)"
env -u PW_PROFILE_DIR -u PW_SESSION PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" \
  CLAUDE_CODE_SESSION_ID='aaaaaaaa-1111-2222-3333-444444444444' \
  PW_CACHE_DIR="$ISO_CACHE" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" open http://iso1 >/dev/null 2>&1
assert_contains "$REC" "-s=pw-aaaaaaaa1111 open" "isolated open uses the session-scoped name"
assert_contains "$REC" "--profile $ISO_CACHE/sessions/aaaaaaaa1111/profile" "isolated open uses the session-scoped profile"

# An explicit PW_PROFILE_DIR is the documented opt-in back to one shared browser;
# it must also force the shared session name, or two differently-named sessions
# would collide on one userDataDir.
SHARED_PROF="$(mktemp -d)/profile"
REC="$(mktemp)"
env -u PW_SESSION PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" \
  CLAUDE_CODE_SESSION_ID='aaaaaaaa-1111-2222-3333-444444444444' \
  PW_PROFILE_DIR="$SHARED_PROF" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" open http://iso2 >/dev/null 2>&1
assert_contains "$REC" "-s=pw open" "explicit PW_PROFILE_DIR opts back into the shared session"
assert_contains "$REC" "--profile $SHARED_PROF" "explicit PW_PROFILE_DIR is honoured"

# forget must leave a marker, else the next open silently re-seeds from golden
# and the user is logged back in despite being told they are logged out.
FORGET_CACHE="$(mktemp -d)"
mkdir -p "$FORGET_CACHE/golden/Default"; touch "$FORGET_CACHE/golden/Default/Cookies"
env -u PW_PROFILE_DIR -u PW_SESSION PATH="$STUB_DIR:$PATH" \
  CLAUDE_CODE_SESSION_ID='cccccccc-1111-2222-3333-444444444444' \
  PW_CACHE_DIR="$FORGET_CACHE" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" forget >/dev/null 2>&1
if [[ -f "$FORGET_CACHE/sessions/cccccccc1111/no-seed" ]]; then
  echo "ok: forget writes the no-seed marker"; PASS=$((PASS+1))
else echo "FAIL: forget did not write the no-seed marker"; FAIL=$((FAIL+1)); fi
REC="$(mktemp)"
env -u PW_PROFILE_DIR -u PW_SESSION PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" \
  CLAUDE_CODE_SESSION_ID='cccccccc-1111-2222-3333-444444444444' \
  PW_CACHE_DIR="$FORGET_CACHE" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" open http://iso3 >/dev/null 2>&1
if [[ -f "$FORGET_CACHE/sessions/cccccccc1111/profile/Default/Cookies" ]]; then
  echo "FAIL: open re-seeded from golden after forget"; FAIL=$((FAIL+1))
else echo "ok: open does not re-seed after forget"; PASS=$((PASS+1)); fi

# forget --golden clears the seed for future sessions too.
env -u PW_PROFILE_DIR -u PW_SESSION PATH="$STUB_DIR:$PATH" \
  CLAUDE_CODE_SESSION_ID='cccccccc-1111-2222-3333-444444444444' \
  PW_CACHE_DIR="$FORGET_CACHE" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" forget --golden >/dev/null 2>&1
if [[ -d "$FORGET_CACHE/golden" ]]; then
  echo "FAIL: forget --golden left the golden profile"; FAIL=$((FAIL+1))
else echo "ok: forget --golden removes the golden profile"; PASS=$((PASS+1)); fi

# status must name the session it is reporting on — `playwright-cli list` is
# global and shows other agents' sessions in the same output.
env -u PW_PROFILE_DIR -u PW_SESSION PATH="$STUB_DIR:$PATH" \
  CLAUDE_CODE_SESSION_ID='aaaaaaaa-1111-2222-3333-444444444444' \
  PW_CACHE_DIR="$ISO_CACHE" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" status >/tmp/pw_status 2>&1
assert_contains /tmp/pw_status "this session: 'pw-aaaaaaaa1111'" "status names its own session"
assert_contains /tmp/pw_status "profile: $ISO_CACHE/sessions/aaaaaaaa1111/profile" "status names its own profile"

echo "---- $PASS passed, $FAIL failed ----"
[[ "$FAIL" -eq 0 ]]
