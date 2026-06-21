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

# --- Task 4: idempotent open ---
run_pw open http://x
assert_contains "$REC" "-s=pw open http://x" "open launches when nothing running"

REC="$(mktemp)"
PATH="$STUB_DIR:$PATH" STUB_RECORD="$REC" STUB_SESSIONS='- pw:\n  - headed: true\n' \
  PW_SCRATCH_DIR="$(mktemp -d)" "$PW" open http://x >/dev/null 2>&1
assert_contains "$REC" "-s=pw goto http://x" "open reuses running session via goto"
assert_not_contains "$REC" "-s=pw open" "open does not relaunch a running session"

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
