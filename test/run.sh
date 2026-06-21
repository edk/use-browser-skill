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
