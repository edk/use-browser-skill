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

# Move the upstream standalone skill OUT of skills/ so it no longer loads.
# Renaming within skills/ is not enough — Claude Code scans every subdir there
# regardless of name, so the disabled copy would still trigger.
UPSTREAM="${HOME}/.claude/skills/playwright-cli"
if [[ -e "$UPSTREAM" || -L "$UPSTREAM" ]]; then
  if [[ "$(readlink "$UPSTREAM" 2>/dev/null)" != "$REPO_DIR" ]]; then
    backup_dir="${HOME}/.claude/use-browser-disabled"
    mkdir -p "$backup_dir"
    moved="${backup_dir}/playwright-cli.$(date +%s)"
    echo "  ~ moving upstream playwright-cli skill out of skills/ -> $moved"
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
