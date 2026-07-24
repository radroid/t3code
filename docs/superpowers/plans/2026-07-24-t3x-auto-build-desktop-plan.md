# t3x — Auto-build & install the desktop app on change (overnight-agent plan)

**Date:** 2026-07-24
**Fork:** `radroid/t3code`
**For:** an overnight implementation agent. This is a brief, implementation-ready plan, not a finished spec — Phase 0 records the design decisions to confirm before coding.
**Branch to cut:** `t3x/auto-build-desktop` off `main` (merge `t3x/setup-and-auto-resume` into `main` first — see the parent conversation).

## Goal

Keep the installed desktop app current automatically: whenever the fork's code changes, rebuild the macOS arm64 `.dmg` and (optionally) reinstall it, with no manual dmg-dragging. This closes the "run-from-source is unbranded / manual rebuild" gap the user hit.

## Reality checks (must inform the design)

1. **A `.dmg` build is heavy** (several minutes) and single-threaded on CPU. So "on _every_ change" must NOT mean "on every file save" — that would rebuild continuously mid-edit. Trigger on a **committed change** (new `HEAD` SHA), not on raw file writes.
2. **A `.dmg` alone doesn't update anything** — it must be _installed_ (mount → copy `.app` to `/Applications`). To actually "automate updating," the script must install too.
3. **Local builds are unsigned** (`T3CODE_DESKTOP_SIGNED=false`). macOS quarantines them → Gatekeeper blocks first launch. The installer step must `xattr -dr com.apple.quarantine` the installed app. (Full code-signing + notarization is only needed for the remote auto-updater path — out of scope, see bottom.)
4. **This assumes the user runs the _installed_ `/Applications/T3 Code.app`**, not the from-source `pnpm start:desktop` process. The two are different processes; auto-install updates the installed app. The user should switch to the installed app for this workflow to make sense.

## Phase 0 — Decisions to confirm (fast; then proceed)

| Decision    | Options                                                                                                             | Recommended                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger** | (a) poll `git HEAD`, rebuild when SHA changes; (b) `fswatch`-style debounced file watch; (c) fixed nightly schedule | **(a)** — no external deps, maps exactly to "a change in the codebase" = a new commit, avoids mid-edit rebuild storms. Optionally also fire after a successful daily upstream sync. |
| **Install** | build-only vs auto-install (+ quarantine strip, + relaunch)                                                         | **auto-install**, opt-in via `--install`; that's the point of the task. Relaunch behind `--relaunch`.                                                                               |
| **Signing** | unsigned local vs signed                                                                                            | **unsigned local** for now (personal machine). Revisit only if moving to the remote auto-updater path.                                                                              |

If the user hasn't said otherwise, proceed with the recommended column.

## Conflict-surface guardrails (do NOT violate — this is a fork)

- **New files only, under `scripts/t3x/`.** The build itself is invoked via the existing `pnpm dist:desktop:dmg:arm64` — never edit `scripts/build-desktop-artifact.ts` (21 commits / 60 days — hot upstream file).
- **Do NOT add npm scripts to the root `package.json`** (hot upstream file). Invoke the shell script by path; document it in a t3x runbook, not via a root script.
- Everything lands in `scripts/t3x/` + `docs/t3x/` so upstream never touches it and the daily rebase stays clean.

## Phased implementation

### Phase 1 — one-shot build (`scripts/t3x/auto-build-desktop.sh`)

- `set -euo pipefail`; resolve repo root.
- **Idempotency:** read last-built SHA from `~/.t3/userdata/t3x-autobuild-last-sha` (or a repo-local `.t3x/` marker). If `git rev-parse HEAD` == last SHA, log "no change" and exit 0.
- If `pnpm-lock.yaml` changed since last build, run `pnpm install --frozen-lockfile`.
- Run `pnpm dist:desktop:dmg:arm64` (add `pnpm --filter @t3tools/desktop ensure:electron` first if the electron runtime is missing).
- Locate the produced artifact (parse electron-builder's printed path, or `find` the newest `*.dmg` under the electron-builder output dir — default `dist/`, confirm at implementation time).
- Write a status JSON (`t3x-autobuild-status.json`: `{ sha, dmgPath, builtAt, result }`) and update the last-built-SHA marker **only on success**.
- **Verify:** run it twice — first produces a `.dmg` + status; second is a no-op ("no change").

### Phase 2 — install mode (`--install`, `--relaunch`)

- `hdiutil attach -nobrowse -quiet "$DMG" -mountpoint "$MNT"`.
- Find `*.app` in the mount (expected `T3 Code.app` — `resolveDesktopProductName` → "T3 Code" for the non-nightly channel).
- Quit the running installed app: `osascript -e 'quit app "T3 Code"'` (best-effort).
- Replace `/Applications/T3 Code.app` (`rm -rf` then `cp -R`), `hdiutil detach`, then `xattr -dr com.apple.quarantine "/Applications/T3 Code.app"`.
- If `--relaunch`: `open "/Applications/T3 Code.app"`.
- **Verify:** run `--install` once; confirm the `/Applications` app's mtime/version updated and it launches without a Gatekeeper block. Do a dry-run (`--install --dry-run` that only logs the steps) first.

### Phase 3 — watch/trigger loop (`--watch [--interval N]`)

- Poll `git rev-parse HEAD` every N seconds (default 60). On a new SHA, run Phase 1 (+ Phase 2 if `--install`).
- Wrap the overnight invocation in `caffeinate -s` so the Mac doesn't sleep mid-run.
- Log to `~/.t3/userdata/logs/t3x-autobuild.log`; never crash the loop on a failed build — log and keep polling.
- **Verify:** start `--watch`, make a trivial commit, confirm a rebuild fires within the interval and the status JSON updates.

### Phase 4 (optional) — hands-off startup

- A `launchd` user agent (`~/Library/LaunchAgents/dev.t3x.autobuild.plist`) that starts `--watch --install` at login, **or** a git `post-merge`/`post-commit` hook (in `.git/hooks`, untracked — document how to install it; do not commit hooks into the tree unless via a documented `core.hooksPath` under `scripts/t3x/hooks/`).
- **Verify:** reboot/login (or fire the hook) and confirm the watcher starts.

### Phase 5 — docs

- `docs/t3x/auto-build-runbook.md`: how to start/stop the watcher, where logs/status live, the Gatekeeper note, and the "use the installed app, not from-source" note. Add a pointer in `docs/t3x/SEAMS.md` (this feature adds **zero** upstream seams — all new files).

## Caveats & risks (call out in the runbook)

- Build time: each rebuild is minutes; back-to-back commits should debounce (only build the latest SHA).
- Auto-install quits/replaces a running app — disruptive if the user is mid-session; fine overnight. Consider skipping install if the app is actively foregrounded (optional).
- Disk: old `.dmg`s accumulate in the output dir — prune to the last N.
- Unsigned app: quarantine-strip is required every install; if macOS tightens Gatekeeper this may need re-visiting.

## Out of scope (the "real" remote auto-update path, for later)

The fully hands-off alternative is **Option C** from the parent conversation: build + **code-sign + notarize** + publish the `.dmg` to the fork's GitHub Releases, and let the app's built-in `electron-updater` pull it (set `T3CODE_DESKTOP_UPDATE_REPOSITORY=radroid/t3code`). That removes the local watcher entirely but needs an Apple Developer signing cert, notarization, and a publish workflow (macOS CI runner). Defer unless the local pipeline proves insufficient.
