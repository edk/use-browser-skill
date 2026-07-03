#!/usr/bin/env bash
# Hermetic tests for bin/pw using the stub playwright-cli.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STUB_DIR="$REPO/test/stub"
PW="$REPO/bin/pw"
PASS=0; FAIL=0

# Isolate the persistent profile dir so tests never touch the real ~/.cache.
export PW_PROFILE_DIR="$(mktemp -d)/profile"

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

# --- Task 5: selftest happy path (hermetic; stub fakes a headed session) ---
REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" STUB_SESSIONS='### Browsers\n- pw:\n  - status: open\n  - browser-type: chrome\n  - user-data-dir: <in-memory>\n  - headed: true\n' \
  PW_SCRATCH_DIR="$(mktemp -d)" "$PW" selftest >/tmp/pw_st 2>&1
if [[ "$?" -eq 0 ]] && grep -q "PASS:" /tmp/pw_st; then echo "ok: selftest happy path exits 0/PASS"; PASS=$((PASS+1))
else echo "FAIL: selftest happy path"; sed 's/^/    /' /tmp/pw_st; FAIL=$((FAIL+1)); fi

# --- Task 4: idempotent open ---
run_pw open http://x
assert_contains "$REC" "-s=pw open --persistent --profile" "open launches with persistent profile by default"
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
assert_contains "$REC" "-s=pw open http://e1" "ephemeral: launches in-memory"
assert_not_contains "$REC" "--persistent" "ephemeral: no --persistent flag"

# fresh: force a new browser (close, then relaunch persistent).
REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" PW_SCRATCH_DIR="$(mktemp -d)" \
  "$PW" fresh http://f1 >/dev/null 2>&1
assert_contains "$REC" "-s=pw close" "fresh: closes existing session first"
assert_contains "$REC" "-s=pw open --persistent --profile" "fresh: relaunches with persistent profile"
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

NUKE_SCRATCH="$(mktemp -d)"; touch "$NUKE_SCRATCH/artifact.yml"
REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" PW_SCRATCH_DIR="$NUKE_SCRATCH" "$PW" nuke >/dev/null 2>&1
assert_contains "$REC" "ARGV: close-all" "nuke -> close-all"
assert_contains "$REC" "ARGV: kill-all" "nuke -> kill-all"
if [[ -d "$NUKE_SCRATCH" ]]; then echo "FAIL: nuke left scratch dir"; FAIL=$((FAIL+1)); else echo "ok: nuke wiped scratch"; PASS=$((PASS+1)); fi

# --- Task 2: session injection ---
run_pw goto http://x
assert_contains "$REC" "-s=pw goto http://x" "default session injected"
run_pw -s=other open http://x
assert_not_contains "$REC" "-s=pw" "caller -s respected"
assert_contains "$REC" "-s=other open http://x" "caller -s passed through"
run_pw list
assert_not_contains "$REC" "-s=pw" "global 'list' not injected"

echo "---- $PASS passed, $FAIL failed ----"
[[ "$FAIL" -eq 0 ]]
