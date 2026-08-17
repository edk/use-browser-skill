#!/usr/bin/env bash
# Real-browser reproduction for per-session isolation.
#
# The hermetic suite (test/run.sh) proves pw builds the right argv. It cannot
# prove that two real Chromium instances coexist, that one session's reaper
# leaves the other's browser alive, or that cookies survive a close/reopen.
# Those are the failures that actually bit, so this test drives real browsers.
#
# Safety: every path is redirected into a temp dir (PW_CACHE_DIR, PW_SCRATCH_DIR),
# so this never touches ~/.cache/pw-cli or the shared $TMPDIR/pw-cli daemon, and
# therefore never disturbs a live pw session belonging to a real agent session.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PW="$REPO/bin/pw"
PASS=0; FAIL=0
ok()   { echo "ok: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
ck()   { if [[ "$1" == "$2" ]]; then ok "$3"; else bad "$3 (want '$2', got '$1')"; fi; }

command -v playwright-cli >/dev/null 2>&1 || { echo "SKIP: playwright-cli not installed"; exit 0; }

TMP="$(mktemp -d)"
export PW_CACHE_DIR="$TMP/cache"
export PW_SCRATCH_DIR="$TMP/scratch"
export PLAYWRIGHT_MCP_HEADLESS=true   # never pop windows during a test run
mkdir -p "$PW_CACHE_DIR" "$PW_SCRATCH_DIR"

# Distinctive keys so stray daemon records are identifiable and greppable.
# Derive the key exactly as pw does rather than hand-writing it — hand-writing
# it silently desynchronises the assertions from the code under test.
keyof() { printf '%s' "$1" | tr -cd 'a-zA-Z0-9' | cut -c1-12; }
A_ID="isotestaaa1-0000-0000-0000-000000000000"; A_KEY="$(keyof "$A_ID")"; A_SESS="pw-$A_KEY"
B_ID="isotestbbb2-0000-0000-0000-000000000000"; B_KEY="$(keyof "$B_ID")"; B_SESS="pw-$B_KEY"
C_ID="isotestccc3-0000-0000-0000-000000000000"; C_KEY="$(keyof "$C_ID")"; C_SESS="pw-$C_KEY"

# --- local site (cookies need a real origin; file: URLs are blocked) ---------
SITE="$TMP/site"; mkdir -p "$SITE/a" "$SITE/b"
printf '<title>PAGE-A</title><h1>A</h1>' > "$SITE/a/index.html"
printf '<title>PAGE-B</title><h1>B</h1>' > "$SITE/b/index.html"
PORT=""
for p in 8731 8732 8733 8734 8735; do
  if ! nc -z 127.0.0.1 "$p" >/dev/null 2>&1; then PORT="$p"; break; fi
done
[[ -n "$PORT" ]] || { echo "SKIP: no free port"; rm -rf "$TMP"; exit 0; }
# `exec` so the subshell is REPLACED by python and $! is python's own pid.
# Without it, $! is the subshell and the kill in cleanup leaves the server
# listening forever, which starves the port pool on the next run.
( cd "$SITE" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 ) &
SERVER_PID=$!
URL_A="http://127.0.0.1:$PORT/a/"
URL_B="http://127.0.0.1:$PORT/b/"
for _ in 1 2 3 4 5 6 7 8 9 10; do nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1 && break; sleep 0.3; done

cleanup() {
  for id in "$A_ID" "$B_ID" "$C_ID"; do
    CLAUDE_CODE_SESSION_ID="$id" "$PW" end >/dev/null 2>&1
  done
  env -u CLAUDE_CODE_SESSION_ID PW_SESSION="pw-isotestlegacy" "$PW" end >/dev/null 2>&1
  # Belt and braces: kill anything still holding a profile under OUR temp dir.
  # Scoped by path, so a real session's browser can never match.
  ps -axo pid=,command= 2>/dev/null | grep -F "user-data-dir=$TMP" | grep -v grep \
    | awk '{print $1}' | while read -r p; do kill -9 "$p" 2>/dev/null; done
  kill "$SERVER_PID" 2>/dev/null
  # Belt and braces: if the pid ever drifts again, do not leave the port held.
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | while read -r p; do kill "$p" 2>/dev/null; done
  find "${HOME}/Library/Caches/ms-playwright/daemon" -maxdepth 2 \
    -name 'pw-isotest*' -delete 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

as() { local id="$1"; shift; CLAUDE_CODE_SESSION_ID="$id" "$PW" "$@"; }
href() {
  local id="$1" out
  out="$(CLAUDE_CODE_SESSION_ID="$id" "$PW" --raw eval 'location.href' 2>/dev/null | head -1)"
  out="${out%\"}"; out="${out#\"}"
  printf '%s' "$out"
}
pids_of() { # PIDs of the browser holding the given session's profile
  ps -axo pid=,command= 2>/dev/null \
    | grep -F "user-data-dir=$PW_CACHE_DIR/sessions/$1/profile" | grep -v grep | awk '{print $1}'
}
alive() { local p; for p in $1; do kill -0 "$p" 2>/dev/null && return 0; done; return 1; }

echo "== 1. two sessions open different URLs =="
as "$A_ID" open "$URL_A" >/dev/null 2>&1 || bad "session A failed to open"
as "$B_ID" open "$URL_B" >/dev/null 2>&1 || bad "session B failed to open"

echo "== 2. each session still sees its own URL (navigation hijack) =="
ck "$(href "$A_ID")" "$URL_A" "A is on its own page after B opened"
ck "$(href "$B_ID")" "$URL_B" "B is on its own page"

echo "== 3. reaping is scoped (no cross-session kills) =="
A_PIDS="$(pids_of "$A_KEY")"
[[ -n "$A_PIDS" ]] && ok "A has a live browser process" || bad "A has no browser process"
as "$B_ID" gc >/dev/null 2>&1
alive "$A_PIDS" && ok "B's 'pw gc' left A's browser alive" || bad "B's 'pw gc' killed A's browser"
as "$B_ID" open "$URL_B" >/dev/null 2>&1
alive "$A_PIDS" && ok "B's 'pw open' left A's browser alive" || bad "B's 'pw open' killed A's browser"
ck "$(href "$A_ID")" "$URL_A" "A still on its own page after B's gc + open"

echo "== 4. sessions are distinct in the registry =="
LIST="$(cd "$PW_SCRATCH_DIR" && playwright-cli list 2>/dev/null)"
printf '%s' "$LIST" | grep -q -- "- $A_SESS:" && ok "registry lists $A_SESS" || bad "registry missing $A_SESS"
printf '%s' "$LIST" | grep -q -- "- $B_SESS:" && ok "registry lists $B_SESS" || bad "registry missing $B_SESS"

echo "== 5. login state survives 'pw end' + reopen within a session =="
as "$A_ID" eval 'document.cookie = "pwiso=alpha; path=/; max-age=86400"' >/dev/null 2>&1
ck "$(as "$A_ID" --raw eval 'document.cookie' 2>/dev/null | tr -d '"' | head -1)" "pwiso=alpha" "cookie set in A"
# Chromium batches cookie writes on a ~30s timer, and Playwright hard-kills the
# browser on teardown rather than asking it to quit, so anything still in the
# batch at close time is lost. Wait out the flush before closing — otherwise
# this asserts Chromium's write scheduling, not pw's profile handling.
COOKIE_DB="$PW_CACHE_DIR/sessions/$A_KEY/profile/Default/Cookies"
flushed() {
  python3 - "$COOKIE_DB" <<'PYEOF' 2>/dev/null
import sqlite3, sys, os, shutil, tempfile
src = sys.argv[1]
if not os.path.exists(src): sys.exit(1)
tmp = os.path.join(tempfile.mkdtemp(), "Cookies"); shutil.copy(src, tmp)
try: n = sqlite3.connect(tmp).execute("select count(*) from cookies").fetchone()[0]
except Exception: sys.exit(1)
sys.exit(0 if n > 0 else 1)
PYEOF
}
for _ in $(seq 1 24); do flushed && break; sleep 2.5; done
flushed && ok "cookie reached disk (Chromium flush timer)" || bad "cookie never flushed to disk in 60s"
as "$A_ID" end >/dev/null 2>&1
as "$A_ID" open "$URL_A" >/dev/null 2>&1
ck "$(as "$A_ID" --raw eval 'document.cookie' 2>/dev/null | tr -d '"' | head -1)" "pwiso=alpha" "cookie survived end+reopen (same session id)"

echo "== 6. a brand-new session does NOT inherit A's cookie without a promote =="
as "$C_ID" open "$URL_A" >/dev/null 2>&1
ck "$(as "$C_ID" --raw eval 'document.cookie' 2>/dev/null | tr -d '"' | head -1)" "" "new session C starts clean"
as "$C_ID" end >/dev/null 2>&1
rm -rf "$PW_CACHE_DIR/sessions/$C_KEY"

echo "== 7. 'pw promote' seeds a brand-new session with saved logins =="
as "$A_ID" end >/dev/null 2>&1
if as "$A_ID" promote >/dev/null 2>&1; then ok "promote succeeded"; else bad "promote failed"; fi
as "$C_ID" open "$URL_A" >/dev/null 2>&1
ck "$(as "$C_ID" --raw eval 'document.cookie' 2>/dev/null | tr -d '"' | head -1)" "pwiso=alpha" "seeded session C inherited the cookie"

echo "== 8. promote refuses to copy a live profile =="
as "$C_ID" promote >/dev/null 2>&1 && bad "promote copied a live profile" || ok "promote refused while browser running"

echo "== 9. 'pw forget' really starts logged out (no silent re-seed) =="
as "$C_ID" forget >/dev/null 2>&1
as "$C_ID" open "$URL_A" >/dev/null 2>&1
ck "$(as "$C_ID" --raw eval 'document.cookie' 2>/dev/null | tr -d '"' | head -1)" "" "forget survives the seeding path"
as "$C_ID" end >/dev/null 2>&1

echo "== 10. no CLAUDE_CODE_SESSION_ID: legacy shared behaviour still works =="
# NEVER launch under the bare session name 'pw' here. playwright-cli resolves
# session names globally across workspaces, so `-s=pw open` from this test would
# attach to a REAL live pw session on the machine and then close someone's
# browser out from under them. (Learned the hard way; `pw selftest` carries the
# same warning.) So: assert the derivation without launching, then launch the
# legacy code path under a unique name.
LEG_HELP="$(env -u CLAUDE_CODE_SESSION_ID "$PW" help 2>/dev/null | head -1)"
case "$LEG_HELP" in
  *"session 'pw',"*) ok "no session id -> default session name 'pw'" ;;
  *) bad "no session id -> wrong session name: $LEG_HELP" ;;
esac
case "$LEG_HELP" in
  *"shared"*) ok "no session id -> reported as shared" ;;
  *) bad "no session id -> not reported as shared" ;;
esac
LEG_SESS="pw-isotestlegacy"
env -u CLAUDE_CODE_SESSION_ID PW_SESSION="$LEG_SESS" "$PW" open "$URL_B" >/dev/null 2>&1
LEG="$(env -u CLAUDE_CODE_SESSION_ID PW_SESSION="$LEG_SESS" "$PW" --raw eval 'location.href' 2>/dev/null | tr -d '"' | head -1)"
ck "$LEG" "$URL_B" "legacy path (no session id) opens and navigates"
[[ -d "$PW_CACHE_DIR/profile" ]] && ok "legacy path uses \$PW_CACHE_DIR/profile" || bad "legacy profile dir missing"
env -u CLAUDE_CODE_SESSION_ID PW_SESSION="$LEG_SESS" "$PW" end >/dev/null 2>&1

echo "== 11. stale-profile sweep never deletes a live profile =="
as "$B_ID" open "$URL_B" >/dev/null 2>&1
# Backdate A's dir well past the TTL; B's browser is live and must be spared.
mkdir -p "$PW_CACHE_DIR/sessions/staleold/profile"
echo 0 > "$PW_CACHE_DIR/sessions/staleold/last-used"
echo 0 > "$PW_CACHE_DIR/sessions/$B_KEY/last-used"
as "$C_ID" gc >/dev/null 2>&1
[[ -d "$PW_CACHE_DIR/sessions/$B_KEY/profile" ]] && ok "sweep spared the session with a live browser" \
  || bad "sweep deleted a live session's profile"
[[ -d "$PW_CACHE_DIR/sessions/staleold" ]] && bad "sweep left an abandoned profile behind" \
  || ok "sweep reaped the abandoned profile"

echo "== 12. legacy shared profile is adopted as the golden seed =="
# Existing installs keep all their logins in the old shared profile. A fresh
# isolated session must inherit them without the user doing anything.
rm -rf "$PW_CACHE_DIR/golden" "$PW_CACHE_DIR/sessions/$C_KEY"
mkdir -p "$PW_CACHE_DIR/profile/Default/Cache"
cp "$PW_CACHE_DIR/sessions/$A_KEY/profile/Default/Cookies" "$PW_CACHE_DIR/profile/Default/Cookies"
echo marker > "$PW_CACHE_DIR/profile/Default/Cache/pwiso-marker"
as "$C_ID" open "$URL_A" >/dev/null 2>&1
ck "$(as "$C_ID" --raw eval 'document.cookie' 2>/dev/null | tr -d '"' | head -1)" "pwiso=alpha" \
  "new session inherited logins from the pre-isolation shared profile"
[[ -d "$PW_CACHE_DIR/golden" ]] && ok "legacy profile was adopted as golden" || bad "golden not created"
# Default (rsync) copy path must drop the caches, which are ~95% of a real profile.
[[ -e "$PW_CACHE_DIR/golden/Default/Cache/pwiso-marker" ]] \
  && bad "rsync path copied cache into golden" || ok "rsync path pruned cache into golden"
[[ -e "$PW_CACHE_DIR/sessions/$C_KEY/profile/Default/Cache/pwiso-marker" ]] \
  && bad "rsync path copied cache into the session profile" || ok "rsync path pruned cache into the session"
# The legacy profile is a seed SOURCE and must never be modified by adoption.
[[ -e "$PW_CACHE_DIR/profile/Default/Cache/pwiso-marker" ]] \
  && ok "legacy profile left intact by adoption" || bad "adoption modified the legacy profile"
as "$C_ID" end >/dev/null 2>&1

echo "== 13. the cp fallback copy path also carries logins =="
# Machines without rsync take a different copy path entirely. An untested copy
# path is how a seeded profile silently arrives without its cookies.
rm -rf "$PW_CACHE_DIR/golden" "$PW_CACHE_DIR/sessions/$C_KEY"
# Plant a marker inside a cache dir. Chromium recreates Default/Cache the moment
# it launches, so the directory's existence proves nothing; only a file that
# could ONLY have arrived via the copy distinguishes pruned from not-pruned.
mkdir -p "$PW_CACHE_DIR/profile/Default/Cache"
echo marker > "$PW_CACHE_DIR/profile/Default/Cache/pwiso-marker"
CLAUDE_CODE_SESSION_ID="$C_ID" PW_NO_RSYNC=1 "$PW" open "$URL_A" >/dev/null 2>&1
ck "$(as "$C_ID" --raw eval 'document.cookie' 2>/dev/null | tr -d '"' | head -1)" "pwiso=alpha" \
  "cp fallback seeded the session with logins"
[[ -e "$PW_CACHE_DIR/sessions/$C_KEY/profile/Default/Cookies" ]] \
  && ok "cp fallback kept Default/Cookies" || bad "cp fallback lost Default/Cookies"
[[ -e "$PW_CACHE_DIR/golden/Default/Cache/pwiso-marker" ]] \
  && bad "cp fallback copied cache into golden" || ok "cp fallback pruned cache into golden"
[[ -e "$PW_CACHE_DIR/sessions/$C_KEY/profile/Default/Cache/pwiso-marker" ]] \
  && bad "cp fallback copied cache into the session profile" || ok "cp fallback pruned cache into the session"
as "$C_ID" end >/dev/null 2>&1

echo "---- $PASS passed, $FAIL failed ----"
[[ "$FAIL" -eq 0 ]]
