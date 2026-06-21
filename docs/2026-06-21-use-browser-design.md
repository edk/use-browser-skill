# use-browser — design

Date: 2026-06-21
Status: approved design, pre-implementation
Owner: edk

## Problem

The upstream `playwright-cli` skill (Microsoft's, shipped with the `@playwright/cli`
binary) is capable, but when an agent uses it the behavior is often not what I want.
Two concrete, recurring failures:

1. Browser lifecycle. The agent spawns new browsers and/or leaves zombie browsers
   running, or closes a browser that should have stayed open. Sessions proliferate.
2. Repo litter. playwright-cli writes snapshots/screenshots/traces into
   `.playwright-cli/` in the current working directory, so artifacts pile up inside
   whatever repo the agent is in (and become a deletion hazard).

Headed-by-default was a third symptom, already fixed via the `PLAYWRIGHT_MCP_HEADLESS`
env var; this design folds that into the same mechanism so it travels too.

Two constraints beyond the fixes:

- Portable. I run Claude Code on more than one machine; the fix must install cleanly
  on a fresh machine without hand-editing per-machine settings.
- Shareable. This is not just my problem; I want to be able to hand it to someone
  else with Claude Code.

## Goals

- Make the desired browser behavior structural (enforced by a wrapper) rather than
  dependent on the agent remembering prose.
- One reusable browser session by default; trivial one-command cleanup.
- Zero artifacts written into any repo.
- Headed by default.
- Self-contained skill: install = clone + one script; share = hand over the repo.
- Depend only on the `playwright-cli` binary, nothing else.

## Non-goals

- Real-time multiplayer co-browsing (two live cursors). Out of scope; it's a shared
  window with turn-taking on shared page state.
- Vendoring the playwright-cli binary or browser binaries into the repo.
- Replacing cosession. cosession remains the tool for interactive, CDP-attach
  debugging of your own running app. use-browser is for agent-driven automation of
  arbitrary web pages.

## Approach (chosen: wrapper-as-skill)

A small standalone git repo, symlinked into `~/.claude/skills/`, containing a wrapper
command `pw` plus a self-contained skill that tells the agent to use `pw`. The wrapper
sets the right env and session defaults itself, so the behavior is machine-independent
and shareable. This mirrors the cosession install model, which already works portably.

## Architecture

### Repo layout

```
~/code/use-browser-skill/            # git repo (symlink source)
  SKILL.md                           # the skill (name: use-browser)
  bin/pw                             # the wrapper (bash)
  install.sh                         # idempotent installer (mirrors cosession)
  README.md                          # what / why / how, for sharing
  docs/2026-06-21-use-browser-design.md
```

Installed as: `~/.claude/skills/use-browser` -> symlink to the repo.
Command on PATH as: `pw` (see install.sh).

### Component: `bin/pw` (the wrapper)

This is where the good behavior becomes structural. Bash, `set -euo pipefail`.

Responsibilities:

- Locate the real `playwright-cli` on PATH. If missing, print the install hint and
  exit non-zero (do not silently no-op).
- Set defaults, each only if not already set by the caller (caller can override):
  - `PLAYWRIGHT_MCP_HEADLESS` defaults to `false` (headed).
  - Scratch dir: `PW_SCRATCH_DIR` defaults to `${TMPDIR:-/tmp}/pw-cli`; create it;
    export `PLAYWRIGHT_MCP_OUTPUT_DIR` to it. This is the #3 fix — all artifacts land
    here, never in a repo.
- Default session: `PW_SESSION` defaults to `pw`. For session-scoped passthrough
  commands, inject `-s=<session>` unless the caller already passed `-s=`/`-s `. This
  is the #2 fix — everything reuses one browser instead of spawning new ones.
- Idempotent `open`: if the session's browser is already running (checked via
  `playwright-cli list`), reuse it — navigate (`goto`) if a URL was given rather than
  launching a second window; otherwise report it's already open.
- Wrapper-only verbs (intercepted before passthrough):
  - `pw status` -> `playwright-cli list` (what's running).
  - `pw end` -> close just our session.
  - `pw nuke` -> `close-all` + `kill-all` + remove the scratch dir (full reset).
  - `pw selftest` -> the verification sequence (see Verification).
  - `pw help` / no args -> wrapper usage, then defers to `playwright-cli --help`.
- Everything else passes straight through to `playwright-cli` unchanged, so the full
  command surface remains available.

Global playwright-cli commands (`list`, `close-all`, `kill-all`, `install`) are
surfaced through the wrapper verbs rather than -s injection, so injection only applies
to session-scoped commands.

### Component: `SKILL.md`

- name: `use-browser`
- description: triggering-only, third person, "Use when…", with keywords (navigate,
  click, fill/submit a form, screenshot, scrape/extract page data, log into a site,
  test a web page, browser automation) and an explicit lane vs cosession (this is for
  agent-driven automation of any web page; cosession is for interactive debugging of
  your own running app). No workflow summary in the description (per writing-skills:
  a workflow summary becomes a shortcut the agent follows instead of reading the body).
- Body, kept under ~500 words:
  - One rule first: use `pw` for all browser work; never call `playwright-cli`
    directly.
  - Lifecycle: one session per task; `pw end` when done; `pw nuke` to reset; `pw
    status` to see what's running.
  - Artifacts are handled automatically (scratch dir) — do not write output paths
    into the repo.
  - A short curated list of the common commands (open/goto/snapshot/click/fill/type/
    screenshot/eval/--raw), then: full surface via `pw --help` / `playwright-cli
    --help`. The catalog is not duplicated here (it changes weekly upstream).
  - Carry over the persistent-profile guidance previously added to the upstream skill:
    for sites behind a login, use `--persistent` plus `state-save`/`state-load`.

### Component: `install.sh` (mirrors cosession)

Idempotent, safe to re-run after `git pull`.

1. Symlink the repo into `~/.claude/skills/use-browser` (back up any existing
   non-symlink target first).
2. Put `pw` on PATH: symlink `bin/pw` -> `~/.local/bin/pw`; if `~/.local/bin` is not
   on PATH, print a one-line note telling the user to add it. The skill also documents
   the stable absolute fallback `~/.claude/skills/use-browser/bin/pw`, which works on
   every machine after install regardless of PATH.
3. Ensure the `playwright-cli` binary exists. If missing, offer to install it
   (`npm i -g @playwright/cli@latest`, or point at Homebrew), with consent; otherwise
   print the command and continue.
4. Replace the upstream standalone skill: if `~/.claude/skills/playwright-cli` exists,
   move it aside to `~/.claude/skills/playwright-cli.disabled.<timestamp>` so only
   use-browser triggers on browser tasks. Reversible. Note in output: do not run
   `playwright-cli install --skills` afterward — use-browser supersedes it.

### Component: `README.md`

What it is, why it exists, the two problems it fixes, install steps, how to share
(clone + `bash install.sh`), and a note that it's plugin-ready for later packaging.

## Dependency management

- Runtime dependency is the `playwright-cli` binary only. Not vendored — vendoring
  pulls hundreds of MB of browser binaries and recreates the weekly-update burden.
  `install.sh` ensures it's present.
- No dependency on the upstream skill or its reference docs. The full command catalog
  is deferred to `--help` (authoritative and always current), so nothing drifts and
  the skill is genuinely standalone.

## How this fixes the problems

- #2 (lifecycle): one reusable session + idempotent open removes proliferation;
  `pw end` / `pw nuke` make cleanup a single command. The wrapper cannot force the
  agent to always close, but the worst case is one reusable window, not a pile.
- #3 (litter): `PLAYWRIGHT_MCP_OUTPUT_DIR` -> scratch dir redirects every
  snapshot/screenshot/trace out of the repo. Verified in the 0.1.14 binary that this
  env var is read and that the output dir is configurable.

## Verification (`pw selftest`)

In a throwaway cwd:

1. `pw open about:blank`
2. `pw status` asserts the session shows `headed: true`.
3. Assert no `.playwright-cli/` directory was created in the cwd.
4. Assert the snapshot/artifact landed under the scratch dir.
5. `pw end` closes the session.
6. Print PASS/FAIL.

## Edge cases / error handling

- `playwright-cli` missing: clear error + install hint, non-zero exit.
- Caller passes their own `-s=`: respected, no injection.
- Caller passes their own `PLAYWRIGHT_MCP_*`: respected, wrapper does not override.
- Scratch dir creation failure: fail loudly, do not fall back to cwd.
- `~/.local/bin` not on PATH: install prints the fix; absolute path still works.
- `pw` name collision: verified free on the current machine; install warns if a
  conflicting `pw` is found.

## Portability and sharing

- Portable: clone + `bash install.sh` on any machine; no per-machine settings edits
  required (the wrapper carries the env). The `PLAYWRIGHT_MCP_HEADLESS` entry in
  `~/.claude/settings.json` becomes redundant once use-browser is in place; it can be
  removed as cleanup but is harmless.
- Shareable now: hand someone the repo; they run `install.sh`.
- Future: package as a Claude Code plugin / marketplace entry for one-command install.
  Out of scope for v1.

## Open questions / future

- Plugin packaging (deferred).
- Optional vendoring mode for fully offline/reproducible installs (deferred).
- Whether `pw` should auto-`end` stale sessions after some idle period (deferred;
  start with explicit cleanup).
