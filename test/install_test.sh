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
ck '! ls -d "$SANDBOX"/.claude/skills/playwright-cli* >/dev/null 2>&1' "no playwright-cli* left under skills/"
ck 'ls -d "$SANDBOX"/.claude/use-browser-disabled/playwright-cli.* >/dev/null 2>&1' "upstream backup exists outside skills/"

# idempotent re-run
HOME="$SANDBOX" INSTALL_SKIP_BIN_CHECK=1 bash "$REPO/install.sh" >/dev/null 2>&1
ck '[[ "$(readlink "$SANDBOX/.claude/skills/use-browser")" == "$REPO" ]]' "re-run keeps skill link"

rm -rf "$SANDBOX"
echo "---- $PASS passed, $FAIL failed ----"; [[ "$FAIL" -eq 0 ]]
