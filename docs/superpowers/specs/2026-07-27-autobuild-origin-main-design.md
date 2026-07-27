# Auto-build from origin/main + unattended relaunch — design

**Date:** 2026-07-27
**Status:** Approved by Raj (chat): "let's start with #2 [--relaunch] … For #3, I
would like to use the origin/main instead of the local state, that would ensure my
local agents can work on a repo branch without breaking it."

## Problem

Two findings from reviewing the desktop auto-update pipeline:

1. **The watcher never fetched.** `--watch` compared `git rev-parse HEAD` of the
   checkout the script lives in against the last-built marker. Nothing pulled, so
   the installed app only updated when Raj manually pulled local main — and any
   agent switching branches in that checkout would change (or break) what gets
   built and installed.
2. **Installs quit the app and never relaunched it.** The LaunchAgent ran
   `--install` without `--relaunch`; `install_dmg` force-quits the app to swap
   `/Applications/T3 Code (Alpha).app`, leaving port 3773 — and therefore the
   Tailscale serve surface, Raj's primary way of using the app — down until a
   manual reopen.

## Design

### `--ref <remote>/<branch>` (script change, this PR)

- Each `build_once` tick in ref mode: `git fetch <remote> <branch>` → resolve the
  remote-tracking SHA → pin a dedicated build worktree to it (detached,
  `checkout --force`) → run the existing build machinery with `$REPO` repointed
  at that worktree.
- Worktree path: `T3X_AUTOBUILD_WORKTREE`, default `<repo>-build`. Created on
  first use (`worktree prune` first, so a deleted-but-registered path can't wedge
  it). Guard: refuses to point at the main repo itself, since the forced checkout
  would clobber it.
- Source of truth is the remote-tracking ref read from the main repo (worktrees
  share refs); the worktree is only checkout machinery. `current_sha` reflects
  this in ref mode.
- Fresh worktree has no `node_modules`; the install step now triggers on
  "`node_modules` missing OR lockfile changed", not lockfile-diff alone.
- Fetch failure (offline) → `fetch-failed` status, marker not advanced, retried
  next tick under the existing backoff (capped at the poll interval).
- `--ref` is forwarded through the caffeinate re-exec and emitted by
  `--print-launchd` (plus `T3X_AUTOBUILD_WORKTREE` in the plist env).
  `WorkingDirectory` in the emitted plist stays the main repo — the build
  worktree may not exist yet, and launchd refuses a missing working directory.

### Relaunch (machine config, not a code change)

`--relaunch` already existed; the deployed LaunchAgent plist gains it alongside
`--ref origin/main`. Post-install the app reopens (~20s blip) instead of staying
quit indefinitely.

## Deliberately kept

- The 12h poll cadence — Raj wants updates on a slow, deliberate schedule.
- The script runs from the main checkout (`~/Developer/t3code`); script updates
  take effect when that checkout is updated. Documented in the runbook.

## Rejected alternatives

- Running the script from inside the build worktree: the forced checkout would
  rewrite the script file mid-execution (bash reads scripts incrementally).
- A post-merge git hook: rebuilds on every local merge, the exact churn the 12h
  cadence was introduced to stop.
- A :3773 health-check watchdog agent: deferred — Raj chose relaunch-first; the
  watchdog is the fallback if relaunch proves flaky.

## Verification

Tested on this branch: bash syntax; flag validation (`--ref` format, unknown
remote, self-worktree guard); dry-run preview with no worktree; real run creating
the worktree at exactly `origin/main`'s SHA with bootstrap-install triggering and
`build-failed` + unadvanced marker on failure; re-sync of a stale worktree;
`--print-launchd` output passes `plutil -lint`.
