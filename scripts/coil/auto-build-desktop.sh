#!/usr/bin/env bash
#
# coil auto-build & install the macOS desktop app on change.
#
# Keeps the installed desktop app current: when the fork's HEAD moves to a new
# commit, rebuild the macOS arm64 .dmg and (optionally) install it — no manual
# dmg-dragging. See docs/coil/auto-build-runbook.md for the full runbook.
#
# The build itself is the existing `pnpm dist:desktop:dmg:arm64` — this script
# never edits scripts/build-desktop-artifact.ts (a hot upstream file). Zero
# upstream seams: everything here lives under scripts/coil/.
#
# Usage:
#   scripts/coil/auto-build-desktop.sh                    # one-shot build if HEAD changed
#   scripts/coil/auto-build-desktop.sh --force            # build even if HEAD unchanged
#   scripts/coil/auto-build-desktop.sh --install          # build + install to /Applications
#   scripts/coil/auto-build-desktop.sh --install --relaunch
#   scripts/coil/auto-build-desktop.sh --install --dry-run # log the install steps, change nothing
#   scripts/coil/auto-build-desktop.sh --watch [--interval 43200] [--install]
#     --watch polls HEAD every --interval seconds (default 12h) and rebuilds only
#     when main has changed since the last build. It does NOT rebuild the instant
#     main moves; a change is picked up at the next poll. Run a one-shot build any
#     time with the plain --install form above (bypasses the interval).
#   scripts/coil/auto-build-desktop.sh --ref origin/main [--watch ...] [--install]
#     --ref builds a REMOTE ref instead of the local checkout: each run fetches the
#     remote, pins a dedicated build worktree (T3X_AUTOBUILD_WORKTREE, default
#     <repo>-build) to that ref's sha, and builds there. The checkout this script
#     lives in is never read for builds, so local branches/agents can't change what
#     gets installed. A fetch failure (offline) is logged and retried next tick.
#   scripts/coil/auto-build-desktop.sh --print-launchd     # emit a ready-to-use LaunchAgent plist
#   scripts/coil/auto-build-desktop.sh --diff-launchd      # diff that plist against the installed one
#     Pass --diff-launchd the SAME flags the agent runs with, or the diff is just those
#     flags. `launchctl print gui/$UID/dev.coil.autobuild` shows what it was installed with.
#     Exit 0 = identical, 1 = differs (diff on stdout), 2 = nothing installed.
#   scripts/coil/auto-build-desktop.sh --help
#
# Exit codes (one-shot mode):
#   0  = built a fresh .dmg (and installed, if --install)
#   3  = no change since last build (no-op)
#   1  = build failed
#
# Env:
#   T3X_AUTOBUILD_STATE_DIR  (default: ~/.t3/userdata)
#   T3CODE_DESKTOP_OUTPUT_DIR (default: <repo>/release) — where the .dmg lands
#   T3X_AUTOBUILD_APP_NAME    (default: derived from the .app inside the .dmg)
#   T3X_AUTOBUILD_KEEP_DMGS   (default: 3) — how many recent .dmgs to keep per prune
#   T3X_AUTOBUILD_WORKTREE    (default: <repo>-build) — build worktree used by --ref
#
set -euo pipefail

# --- resolve paths -----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"

STATE_DIR="${T3X_AUTOBUILD_STATE_DIR:-$HOME/.t3/userdata}"
LOG_DIR="$STATE_DIR/logs"
LAST_SHA_FILE="$STATE_DIR/coil-autobuild-last-sha"
STATUS_FILE="$STATE_DIR/coil-autobuild-status.json"
LOG_FILE="$LOG_DIR/coil-autobuild.log"

KEEP_DMGS="${T3X_AUTOBUILD_KEEP_DMGS:-3}"
# Validated because it is fed to `tail -n +$((KEEP_DMGS + 1))`: a non-numeric value makes
# the arithmetic yield 1, so `tail -n +1` prunes EVERY dmg including the one just built,
# and `$(( ))` on attacker-shaped input is a command-execution sink.
if ! [[ "$KEEP_DMGS" =~ ^[0-9]+$ ]] || [[ "$KEEP_DMGS" -lt 1 ]]; then
  echo "T3X_AUTOBUILD_KEEP_DMGS must be a positive integer (got: '$KEEP_DMGS')" >&2
  exit 2
fi
APPLICATIONS_DIR="${T3X_AUTOBUILD_APPLICATIONS_DIR:-/Applications}"

# --- flags -------------------------------------------------------------------
DO_INSTALL=0
DO_RELAUNCH=0
DO_WATCH=0
DRY_RUN=0
FORCE=0
# Default watch cadence: 12h. This machine builds on a slow, deliberate schedule
# (rebuild at most once per interval, and only if main changed) rather than tracking
# every main commit — override with --interval for a tighter loop when actively iterating.
INTERVAL=43200
CAFFEINATED=0
INSTALL_OK=0   # set only after an install actually succeeds; drives status JSON
BUILD_REF=""   # --ref remote/branch: build that ref in a dedicated worktree, not this checkout

usage() { grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//;s/^#$//'; }

# Kept for --diff-launchd, which quotes the invocation back in its report. The parse loop
# below consumes $@, so capture it first. Every read of these uses `[*]:-`, not `[*]`: this
# script runs under `set -u`, and the /bin/bash the LaunchAgent invokes is 3.2, where
# expanding an EMPTY array without a default is an "unbound variable" error.
ORIGINAL_ARGV=("$@")
ORIGINAL_ARGV_NO_DIFF=()
for _arg in "$@"; do
  [[ "$_arg" == "--diff-launchd" ]] || ORIGINAL_ARGV_NO_DIFF+=("$_arg")
done
unset _arg

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) DO_INSTALL=1 ;;
    --relaunch) DO_RELAUNCH=1 ;;
    --watch) DO_WATCH=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --interval) INTERVAL="${2:?--interval needs a value}"; shift ;;
    --interval=*) INTERVAL="${1#*=}" ;;
    --ref) BUILD_REF="${2:?--ref needs a value (e.g. origin/main)}"; shift ;;
    --ref=*) BUILD_REF="${1#*=}" ;;
    --print-launchd) PRINT_LAUNCHD=1 ;;
    --diff-launchd) DIFF_LAUNCHD=1 ;;
    --_caffeinated) CAFFEINATED=1 ;;  # internal: set after re-exec under caffeinate
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

# A non-numeric interval makes `sleep` fail and kills the watcher; 0 turns the poll into a
# tight loop that rebuilds continuously. Reject both up front rather than at 3am.
if ! [[ "$INTERVAL" =~ ^[0-9]+$ ]] || [[ "$INTERVAL" -lt 1 ]]; then
  echo "--interval must be a positive integer (got: '$INTERVAL')" >&2
  exit 2
fi

# --- ref mode: build a remote ref in a dedicated worktree --------------------
# $REPO is repointed at the build worktree so every downstream consumer (sha
# compare, lockfile diff, pnpm cwd, app-name prediction, relative OUTPUT_DIR)
# operates on the pinned checkout. $MAIN_REPO keeps the script's own repo for
# the git operations that manage the worktree (fetch, worktree add).
MAIN_REPO="$REPO"
if [[ -n "$BUILD_REF" ]]; then
  if [[ ! "$BUILD_REF" =~ ^[^/]+/.+$ ]]; then
    echo "--ref must be <remote>/<branch> (got: '$BUILD_REF')" >&2
    exit 2
  fi
  REF_REMOTE="${BUILD_REF%%/*}"
  REF_BRANCH="${BUILD_REF#*/}"
  if ! git -C "$MAIN_REPO" remote get-url "$REF_REMOTE" >/dev/null 2>&1; then
    echo "--ref remote '$REF_REMOTE' is not a remote of $MAIN_REPO" >&2
    exit 2
  fi
  BUILD_WT="${T3X_AUTOBUILD_WORKTREE:-${MAIN_REPO}-build}"
  # `checkout --force` runs in this directory every sync; pointing it at the main
  # checkout would clobber whatever branch (and uncommitted work) is there.
  if [[ "$BUILD_WT" == "$MAIN_REPO" ]]; then
    echo "T3X_AUTOBUILD_WORKTREE must not be the repo itself ($MAIN_REPO)" >&2
    exit 2
  fi
  REPO="$BUILD_WT"
fi

# Match scripts/build-desktop-artifact.ts, which does `path.resolve(repoRoot, outputDir)`:
# a RELATIVE override is repo-relative there, so resolving it against $PWD here would make
# us search/prune the caller's ./<dir> and then report "no .dmg" for a build that succeeded.
OUTPUT_DIR="${T3CODE_DESKTOP_OUTPUT_DIR:-release}"
case "$OUTPUT_DIR" in
  /*) ;;                       # absolute override: use as-is
  *) OUTPUT_DIR="$REPO/$OUTPUT_DIR" ;;
esac

mkdir -p "$STATE_DIR" "$LOG_DIR"

# --- logging -----------------------------------------------------------------
now_iso() { date '+%Y-%m-%dT%H:%M:%S%z'; }

# `tee -a "$LOG_FILE" >&2` writes the line to the log AND echoes it to stderr, which is
# what you want in a terminal. Under launchd it is not: the generated plist points BOTH
# StandardOutPath and StandardErrorPath at $LOG_FILE, so the echo lands straight back in
# the same file and every line appears twice — which reads exactly like two watchers
# racing when only one is running.
#
# print_launchd sets this in the plist it generates, because that plist is precisely
# where stderr gets aimed at the log. Do NOT try to detect it by comparing
# `stat -f '%d:%i' /dev/fd/2` against the log file: on macOS that stats the devfs node
# (e.g. 2540177495:339), never the redirect target, so the comparison can never match.
STDERR_IS_LOG="${T3X_AUTOBUILD_STDERR_IS_LOG:-0}"
log() {
  if [[ "$STDERR_IS_LOG" == "1" ]]; then
    printf '%s %s\n' "$(now_iso)" "$*" >>"$LOG_FILE"
  else
    printf '%s %s\n' "$(now_iso)" "$*" | tee -a "$LOG_FILE" >&2
  fi
}

# --- json status (no jq) -----------------------------------------------------
# NOTE: `printf '%s'`, not a `<<<` here-string. A here-string appends a trailing
# newline, which sys.stdin.read() would capture into every emitted JSON value
# (e.g. "sha": "abc123\n") and break consumers that compare the SHA.
json_escape() { printf '%s' "${1-}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; }
write_status() {
  # args: result sha dmg detail
  local result="$1" sha="$2" dmg="$3" detail="${4:-}"
  {
    printf '{\n'
    printf '  "result": %s,\n' "$(json_escape "$result")"
    printf '  "sha": %s,\n' "$(json_escape "$sha")"
    printf '  "dmgPath": %s,\n' "$(json_escape "$dmg")"
    printf '  "builtAt": %s,\n' "$(json_escape "$(now_iso)")"
    # Reflects the OUTCOME. Deriving this from the flags alone emitted
    # {"result":"install-failed", …, "installed":true} — self-contradictory in one object.
    printf '  "installed": %s,\n' "$([[ ${INSTALL_OK:-0} -eq 1 ]] && echo true || echo false)"
    printf '  "detail": %s\n' "$(json_escape "$detail")"
    printf '}\n'
  } >"$STATUS_FILE"
}

# --- helpers -----------------------------------------------------------------
# In ref mode "what should be built" is the remote-tracking ref, read from the main
# repo (worktrees share refs). The build worktree is only checkout machinery — and it
# may not exist yet (first run, dry-run), so its HEAD cannot be the source of truth.
current_sha() {
  if [[ -n "$BUILD_REF" ]]; then
    git -C "$MAIN_REPO" rev-parse "refs/remotes/$BUILD_REF"
  else
    git -C "$REPO" rev-parse HEAD
  fi
}
read_last_sha() { [[ -f "$LAST_SHA_FILE" ]] && cat "$LAST_SHA_FILE" || printf ''; }

# Ref mode: fetch the remote and pin the build worktree to $BUILD_REF's sha.
# Failure returns 1 without advancing the marker, so the next tick retries.
ensure_ref_synced() {
  local sha
  if ! git -C "$MAIN_REPO" fetch --quiet "$REF_REMOTE" "$REF_BRANCH"; then
    write_status "fetch-failed" "" "" "git fetch $REF_REMOTE $REF_BRANCH failed (offline?)"
    log "fetch failed: $REF_REMOTE $REF_BRANCH (offline?); will retry next tick"
    return 1
  fi
  sha="$(git -C "$MAIN_REPO" rev-parse "refs/remotes/$BUILD_REF")" || return 1
  if [[ ! -e "$BUILD_WT/.git" ]]; then
    if [[ $DRY_RUN -eq 1 ]]; then
      log "DRY-RUN would: git worktree add --detach '$BUILD_WT' $sha"
      return 0
    fi
    # prune first: a build worktree deleted from disk stays registered and would
    # make `worktree add` refuse the path forever.
    git -C "$MAIN_REPO" worktree prune 2>/dev/null || true
    log "creating build worktree: $BUILD_WT @ $sha"
    if ! git -C "$MAIN_REPO" worktree add --detach "$BUILD_WT" "$sha"; then
      write_status "worktree-failed" "$sha" "" "git worktree add failed for $BUILD_WT"
      log "FAILED to create build worktree $BUILD_WT"
      return 1
    fi
    return 0
  fi
  if [[ "$(git -C "$BUILD_WT" rev-parse HEAD)" != "$sha" ]]; then
    if [[ $DRY_RUN -eq 1 ]]; then
      log "DRY-RUN would: sync build worktree $BUILD_WT to $sha"
      return 0
    fi
    # --force: stray build outputs must never block an update; node_modules is
    # untracked and survives. --detach: never hold a branch, so main and the
    # other worktrees stay free to check anything out.
    if ! git -C "$BUILD_WT" checkout --force --detach --quiet "$sha"; then
      write_status "worktree-failed" "$sha" "" "checkout failed in $BUILD_WT"
      log "FAILED to sync build worktree to $sha"
      return 1
    fi
    log "build worktree synced to $sha"
  fi
  return 0
}

lockfile_changed() {
  # $1 = last sha ("" if unknown). True (0) when the lockfile differs or last is unknown.
  local last="$1"
  [[ -z "$last" ]] && return 0
  git -C "$REPO" cat-file -e "${last}^{commit}" 2>/dev/null || return 0
  git -C "$REPO" diff --name-only "$last" HEAD -- pnpm-lock.yaml | grep -q . && return 0
  return 1
}

# NOTE: deliberately `ls -t <glob>` rather than `find … | xargs -0 ls -t`. On macOS
# xargs still runs the utility when its input is empty, so the find form would run a
# bare `ls -t` and return an unrelated file from the cwd when no .dmg exists.
# A non-matching glob makes `ls` fail into an empty string instead, which is what we want.
list_dmgs_newest_first() { ls -t "$OUTPUT_DIR"/*.dmg 2>/dev/null || true; }

newest_dmg() { list_dmgs_newest_first | head -1; }

prune_dmgs() {
  # keep the newest $KEEP_DMGS .dmgs, delete the rest (best-effort)
  local old
  old="$(list_dmgs_newest_first | tail -n +"$((KEEP_DMGS + 1))")"
  [[ -z "$old" ]] && return 0
  while IFS= read -r f; do
    [[ -n "$f" ]] && { log "prune old dmg: $f"; rm -f "$f" || true; }
  done <<<"$old"
  # Explicit: without it the function's status is the last `rm`, and in one-shot mode
  # errexit is live here — a single failing rm aborted the script with exit 1 *after* a
  # fully successful build+install had already written "result":"built".
  return 0
}

# --- mutual exclusion --------------------------------------------------------
# Concurrency is realistic, not theoretical: hooks/post-merge nohups a detached build on
# EVERY merge, so two quick `git pull`s start two electron-builder runs writing the same
# output dir — and one can rm -rf the install target while the other is mid-copy.
# mkdir is atomic on every filesystem we care about; `flock` is not on stock macOS.
LOCK_DIR="$STATE_DIR/coil-autobuild.lock"

release_lock() { rm -rf "$LOCK_DIR" 2>/dev/null || true; }

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s' "$$" >"$LOCK_DIR/pid" 2>/dev/null || true
    trap release_lock EXIT
    return 0
  fi
  # A crashed run must not wedge the watcher forever: steal the lock if its owner is gone.
  local owner
  owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || printf '')"
  if [[ -n "$owner" ]] && kill -0 "$owner" 2>/dev/null; then
    return 1
  fi
  log "clearing stale lock (owner pid ${owner:-unknown} is not running)"
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || return 1
  printf '%s' "$$" >"$LOCK_DIR/pid" 2>/dev/null || true
  trap release_lock EXIT
  return 0
}

# --- code signing ------------------------------------------------------------
# Issue #70. An ad-hoc signed build's designated requirement is its own cdhash, so macOS sees a
# brand-new app after every install and re-requests Screen Recording, Accessibility, Microphone,
# Files & Folders and Local Network. Signing with the fork's stable identity is what makes a grant
# survive an update; see docs/coil/mac-signing-runbook.md.
#
# electron-builder needs nothing from us but CSC_NAME. build-desktop-artifact.ts (upstream-owned)
# forces CSC_IDENTITY_AUTO_DISCOVERY=false for unsigned builds, but app-builder-lib consults that
# flag only when NO identity was named: findIdentity() reads `qualifier || process.env.CSC_NAME`
# first. An empty CSC_NAME counts as absent, so a machine with no identity keeps today's behaviour
# exactly — which is why this needs no upstream edit and no new SEAMS.md row.
SETUP_SIGNING="$SCRIPT_DIR/setup-mac-signing.sh"

# Kept in one place so the build and the verifier cannot disagree about it. The single source of
# truth is DESKTOP_BUNDLE_IDENTIFIER in scripts/coil/mac-signature.ts, and a test asserts this
# literal matches it.
DESKTOP_APP_ID="dev.curlycloud.t3coil"

# Prints the identity name, or nothing at all when this machine has none set up. Never fails: an
# unsigned build is worse than a signed one but better than no build.
signing_identity() {
  [[ -x "$SETUP_SIGNING" ]] || return 0
  # Keychains lock on reboot, and a locked keychain is invisible to `security find-identity -v` —
  # which is indistinguishable from "no identity" at exactly the wrong moment (an unattended
  # overnight build), so unlock first and ask second.
  "$SETUP_SIGNING" --unlock >/dev/null 2>&1 || return 0
  "$SETUP_SIGNING" --status >/dev/null 2>&1 || return 0
  "$SETUP_SIGNING" --print-identity
}

log_signing_state() {
  local identity="$1"
  if [[ -n "$identity" ]]; then
    log "signing: '$identity' — permissions granted to the installed app will survive this update"
  else
    log "signing: NONE. This build will be ad-hoc signed, so macOS will ask for every permission"
    log "signing: again after it installs — and again after the next build. Fix it once with:"
    log "signing:   scripts/coil/setup-mac-signing.sh"
  fi
}

# Refuse to install a build that would cost the user a round of permission dialogs.
#
# The check runs against the built .dmg, and uses the verifier from the commit that was built (which
# is the build worktree when --ref is in play), not from this checkout.
verify_signature() {
  local dmg="$1" identity="$2"
  local verifier="$REPO/scripts/coil/verify-mac-signature.ts"
  local recorded="$REPO/docs/coil/mac-signing/designated-requirement.txt"
  [[ -f "$verifier" ]] || return 0

  local args=(--artifact "$dmg")
  [[ -f "$recorded" ]] && args+=(--expect-requirement-file "$recorded")
  if [[ -n "$identity" ]]; then
    args+=(--expect-authority "$identity")
  else
    # Only tolerated because this machine knowingly has no identity. A build signed by a
    # DIFFERENT identity is never tolerated: it looks fixed and is not.
    args+=(--allow-unsigned)
  fi
  ( cd "$REPO" && node "$verifier" "${args[@]}" )
}

# --- install -----------------------------------------------------------------
# Answer "which .app would be installed?" WITHOUT changing anything.
#
# LOGIC MIRROR of scripts/build-desktop-artifact.ts (resolveDesktopUpdateChannel /
# resolveDesktopProductName). Only used when no .dmg exists yet to read the name out of;
# if that upstream logic changes, this prediction goes stale (the dmg peek below does not).
predicted_app_name() {
  python3 - "$REPO/apps/desktop/package.json" <<'PY' 2>/dev/null || printf 'T3 Coil'
import json, re, sys
try:
    pkg = json.load(open(sys.argv[1]))
except Exception:
    print("T3 Coil"); raise SystemExit(0)
version = pkg.get("version", "")
# resolveDesktopUpdateChannel: /-nightly\.\d{8}\.\d+$/ -> nightly, else latest
if re.search(r"-nightly\.\d{8}\.\d+$", version):
    print("T3 Code (Nightly)")
else:
    print(pkg.get("productName") or "T3 Coil")
PY
}

# Resolve the .app basename (without ".app"). Prefers ground truth over prediction:
# explicit env override > the actual name inside the built dmg > upstream-mirrored guess.
resolve_app_name() {
  local dmg="$1" mnt app
  if [[ -n "${T3X_AUTOBUILD_APP_NAME:-}" ]]; then printf '%s' "$T3X_AUTOBUILD_APP_NAME"; return 0; fi
  if [[ -n "$dmg" && -f "$dmg" ]]; then
    mnt="$(mktemp -d "${TMPDIR:-/tmp}/coil-peek.XXXXXX")"
    # -readonly: peeking must never modify the artifact, even in a dry run.
    if hdiutil attach -nobrowse -readonly -quiet "$dmg" -mountpoint "$mnt" >/dev/null 2>&1; then
      app="$(find "$mnt" -maxdepth 1 -name '*.app' | head -1)"
      hdiutil detach "$mnt" -quiet >/dev/null 2>&1 || true
      rmdir "$mnt" 2>/dev/null || true
      if [[ -n "$app" ]]; then printf '%s' "$(basename "$app" .app)"; return 0; fi
    else
      rmdir "$mnt" 2>/dev/null || true
    fi
  fi
  predicted_app_name
}

install_dmg() {
  local dmg="$1"

  # The whole point of `--install --dry-run` is to answer "which app gets replaced?"
  # before you let it touch /Applications. It used to answer with a hardcoded
  # "${T3X_AUTOBUILD_APP_NAME:-T3 Code}.app" and never look at the dmg at all, so on this
  # repo it always claimed `T3 Code.app` — an app that does not exist — while a real
  # install replaced `T3 Code (Alpha).app`. It also bailed out entirely before printing
  # anything when no dmg had been built yet, which is every first-time user.
  if [[ $DRY_RUN -eq 1 ]]; then
    local d_appbase d_target
    d_appbase="$(resolve_app_name "$dmg").app"
    d_target="$APPLICATIONS_DIR/$d_appbase"
    if [[ -n "$dmg" && -f "$dmg" ]]; then
      log "DRY-RUN install: read '$d_appbase' from $dmg"
    else
      log "DRY-RUN install: no .dmg built yet; '$d_appbase' predicted from apps/desktop/package.json"
    fi
    log "install: '$d_appbase' -> '$d_target'"
    log "DRY-RUN would: quit app '${d_appbase%.app}'"
    log "DRY-RUN would: rm -rf '$d_target' && cp -R <app-from-dmg> '$d_target'"
    log "DRY-RUN would: xattr -dr com.apple.quarantine '$d_target'  (not notarized)"
    [[ $DO_RELAUNCH -eq 1 ]] && log "DRY-RUN would: open '$d_target'"
    # The footgun this preview exists to catch: if the target is absent, a real --install
    # CREATES a new app and silently leaves the one you actually launch untouched.
    if [[ -e "$d_target" ]]; then
      log "DRY-RUN: '$d_target' exists and WOULD be replaced"
    else
      log "DRY-RUN WARNING: '$d_target' does NOT exist — a real --install would create a NEW app"
      log "DRY-RUN WARNING: and leave whatever you currently run untouched. See docs/coil/auto-build-runbook.md"
    fi
    return 0
  fi

  [[ -z "$dmg" || ! -f "$dmg" ]] && { log "install: no .dmg to install ($dmg)"; return 1; }

  local mnt app appbase target
  mnt="$(mktemp -d "${TMPDIR:-/tmp}/coil-dmg.XXXXXX")"
  # shellcheck disable=SC2064
  trap "hdiutil detach '$mnt' -quiet >/dev/null 2>&1 || true; rmdir '$mnt' 2>/dev/null || true" RETURN

  hdiutil attach -nobrowse -quiet "$dmg" -mountpoint "$mnt"

  app="$(find "$mnt" -maxdepth 1 -name '*.app' | head -1)"
  [[ -z "$app" ]] && { log "install: no .app found in $dmg"; return 1; }
  appbase="$(basename "$app")"
  target="$APPLICATIONS_DIR/$appbase"

  log "install: '$appbase' -> '$target'"

  # Best-effort quit of the running app so we can replace it.
  osascript -e "quit app \"${appbase%.app}\"" >/dev/null 2>&1 || true

  # Stage beside the target, then swap. Copying straight onto the target is wrong twice:
  #  * BSD `cp -R src.app dst.app` copies INTO dst.app when dst.app still exists, silently
  #    nesting the new build inside the old one and exiting 0 — so the user keeps running
  #    the old app while every poll reports "no change".
  #  * Deleting the working app BEFORE the copy leaves nothing installed if the copy then
  #    fails (ENOSPC is realistic: each build writes ~470MB into release/).
  # `install_dmg` is called as `install_dmg … || install_failed=1`, which disables errexit
  # for its whole dynamic extent, so each step is checked explicitly.
  local staged="$target.coil-new"
  rm -rf "$staged"
  if ! cp -R "$app" "$staged"; then
    log "install: FAILED to copy '$app' -> '$staged'"
    rm -rf "$staged"
    return 1
  fi
  # Only now is the old app touched; a failure above leaves it intact and working.
  if ! rm -rf "$target"; then
    log "install: FAILED to remove existing '$target' (owned by root, or locked?)"
    rm -rf "$staged"
    return 1
  fi
  if ! mv "$staged" "$target"; then
    log "install: FAILED to move '$staged' -> '$target'"
    return 1
  fi
  # Unsigned local builds are quarantined by macOS; strip it so Gatekeeper allows launch.
  xattr -dr com.apple.quarantine "$target" || true
  log "install: replaced $target"
  [[ $DO_RELAUNCH -eq 1 ]] && { log "install: relaunching $appbase"; open "$target" || true; }
  return 0
}

# --- build -------------------------------------------------------------------
build_once() {
  local cur last
  # Ref mode: fetch + pin the build worktree first — current_sha reads the
  # remote-tracking ref, which is only meaningful after a fresh fetch.
  if [[ -n "$BUILD_REF" ]]; then
    ensure_ref_synced || return 1
  fi
  cur="$(current_sha)"
  last="$(read_last_sha)"

  if [[ "$cur" == "$last" && $FORCE -eq 0 ]]; then
    log "no change since last build ($cur); nothing to do"
    return 3
  fi

  log "building desktop dmg for $cur (last built: ${last:-none})"

  local signing_id
  signing_id="$(signing_identity)"
  log_signing_state "$signing_id"

  if [[ $DRY_RUN -eq 1 ]]; then
    log "DRY-RUN would: pnpm dist:desktop:dmg:arm64  (cwd $REPO)"
  else
    # These are checked explicitly rather than relying on `set -e`: build_once is called as
    # `if ! build_once` by the watch loop, and bash disables errexit for the whole dynamic
    # extent of a function whose status is being tested. Without these checks a failed
    # install would fall through and the dmg would be built against stale dependencies.
    # A fresh build worktree has NO node_modules at all, and lockfile_changed alone
    # would skip the install whenever the lockfile happens to be unchanged since the
    # last-built sha — guaranteeing a build failure on the worktree's first use.
    if [[ ! -d "$REPO/node_modules" ]] || lockfile_changed "$last"; then
      log "node_modules missing or pnpm-lock.yaml changed -> pnpm install --frozen-lockfile"
      if ! ( cd "$REPO" && pnpm install --frozen-lockfile ); then
        write_status "build-failed" "$cur" "" "pnpm install --frozen-lockfile failed"
        log "BUILD FAILED for $cur (dependency install)"
        return 1
      fi
    fi
    log "ensuring electron runtime"
    if ! ( cd "$REPO" && pnpm --filter @t3tools/desktop ensure:electron ); then
      write_status "build-failed" "$cur" "" "ensure:electron failed"
      log "BUILD FAILED for $cur (electron runtime)"
      return 1
    fi
    log "running: pnpm dist:desktop:dmg:arm64"
    # T3X_DESKTOP_APP_ID: the fork's own bundle id (issue #70). macOS keys one permission row per
    # (service, bundle id), and sharing `com.t3tools.t3code` with upstream's nightly meant whichever
    # app launched last owned the grants. Must match DESKTOP_BUNDLE_IDENTIFIER in
    # scripts/coil/mac-signature.ts — a test asserts it, and verify_signature below fails a build
    # whose signing identifier is anything else.
    if ! ( cd "$REPO" && CSC_NAME="$signing_id" T3X_DESKTOP_APP_ID="$DESKTOP_APP_ID" \
      pnpm dist:desktop:dmg:arm64 ); then
      write_status "build-failed" "$cur" "" "pnpm dist:desktop:dmg:arm64 failed"
      log "BUILD FAILED for $cur"
      return 1
    fi
  fi

  local dmg
  dmg="$(newest_dmg)"
  if [[ $DRY_RUN -eq 0 && -z "$dmg" ]]; then
    write_status "build-failed" "$cur" "" "no .dmg found under $OUTPUT_DIR"
    log "BUILD FAILED: no .dmg under $OUTPUT_DIR"
    return 1
  fi
  if [[ $DRY_RUN -eq 1 ]]; then
    # Nothing was built; this is whatever .dmg already exists (i.e. what --install would use).
    log "DRY-RUN newest existing dmg: ${dmg:-<none>}"
  else
    log "built dmg: $dmg"
    # Before the install, not after: a build whose identity moved would cost the user every
    # permission dialog, and at that point the only honest thing to do is not install it.
    #
    # Captured rather than piped into `log`. `verify … | while read` would report the WHILE LOOP's
    # status, which is always 0 — the same shape of bug the release workflow's retry loop documents.
    local verify_log verify_status=0
    verify_log="$(verify_signature "$dmg" "$signing_id" 2>&1)" || verify_status=$?
    while IFS= read -r line; do [[ -n "$line" ]] && log "$line"; done <<<"$verify_log"
    if [[ $verify_status -ne 0 ]]; then
      write_status "build-failed" "$cur" "$dmg" "signature verification failed"
      log "BUILD FAILED for $cur (signature verification)"
      return 1
    fi
  fi

  local install_failed=0
  if [[ $DO_INSTALL -eq 1 ]]; then
    if install_dmg "$dmg"; then INSTALL_OK=1; else install_failed=1; fi
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    return 0
  fi

  # The marker means "built AND installed, if an install was asked for". Advancing it after
  # a failed install would make the next poll report "no change" while /Applications still
  # holds the old app, so the failure would never be retried.
  if [[ $install_failed -eq 1 ]]; then
    write_status "install-failed" "$cur" "$dmg" "dmg built but install failed; marker not advanced so it retries"
    log "INSTALL FAILED for $cur (dmg built at $dmg); will retry on next run"
    prune_dmgs
    return 1
  fi

  write_status "built" "$cur" "$dmg" "ok"
  printf '%s' "$cur" >"$LAST_SHA_FILE"   # advance marker only on a fully successful run
  prune_dmgs
  return 0
}

# --- launchd plist emitter ---------------------------------------------------
# A path containing & < > (legal on macOS) would otherwise emit a malformed plist that
# launchctl silently refuses to load.
xml_escape() { printf '%s' "${1-}" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }

# macOS TCC (Privacy & Security) gates ~/Desktop, ~/Documents, ~/Downloads and iCloud
# Drive. GUI apps get a consent prompt; launchd agents never do — they just receive
# EPERM. Echo the containing protected root, or return 1.
tcc_protected_path() {
  local p="$1" d
  for d in "$HOME/Desktop" "$HOME/Documents" "$HOME/Downloads" "$HOME/Library/Mobile Documents"; do
    case "$p" in "$d" | "$d"/*) printf '%s' "$d"; return 0 ;; esac
  done
  return 1
}

# --- the agent's PATH --------------------------------------------------------
# A LaunchAgent does not get this shell's PATH. launchd starts jobs from a minimal
# environment with no login shell, so nothing a version manager (fnm, asdf, volta, nvm) or
# rustup writes into a shell profile is ever read. Every directory the build needs has to
# be named in the plist.
#
# This used to be a hardcoded list, and that is a silent-failure machine. The build needs
# node, pnpm, cargo and git; a hardcoded list that loses one of them does not fail loudly:
#
#   - cargo missing → every tick dies with `spawn cargo ENOENT` and backs off (the 07-30
#     outage; fixed by hand in the live plist, and only back-ported in c33e5a361).
#   - node missing from the version manager's directory → the system still has *a* node, so
#     the build SUCCEEDS against the wrong toolchain. On this machine Homebrew's node is a
#     different major version from the one package.json's `engines.node` allows. Nothing
#     reports that; you get a green build of a binary nobody asked for.
#
# So derive it, then prove it. `verify_agent_path` re-checks the emitted list from an empty
# environment, which is the only way to be sure the plist will behave the way this shell does.

# Searched last, so a system tool is used only when nothing more specific provides it.
AGENT_SYSTEM_PATH=(/opt/homebrew/bin /usr/local/bin /usr/bin /bin)
AGENT_REQUIRED_TOOLS=(node pnpm cargo git)

# Does any directory in the colon-joined $1 hold an executable named $2? This is what a
# PATH lookup does, so testing it directly beats spawning a shell to ask.
path_provides() {
  local list="$1" tool="$2" dir
  local IFS=:
  for dir in $list; do
    [[ -n "$dir" && -x "$dir/$tool" ]] && return 0
  done
  return 1
}

# The directory to put on the agent's PATH for $1, or nothing if the tool is missing here.
#
# Resolving the symlink chain is the point. A version manager's shim lives in a per-shell
# directory — fnm's is ~/.local/state/fnm_multishells/<pid>_<stamp>/bin — which is deleted
# when that shell exits. Baking a shim path into a plist that outlives the shell produces an
# agent whose PATH entry has silently ceased to exist.
stable_tool_dir() {
  local tool="$1" cmd resolved dir
  cmd="$(command -v "$tool" 2>/dev/null)" || return 0
  [[ -n "$cmd" ]] || return 0
  resolved="$(readlink -f "$cmd" 2>/dev/null || printf '%s' "$cmd")"
  dir="$(dirname "$resolved")"
  # corepack ships pnpm/yarn as a .js file under lib/node_modules, so following pnpm's
  # symlink lands in `.../corepack/dist`, which is not a bin directory at all. When the
  # resolved directory does not actually hold the executable, there is nothing stable to
  # name — and that is fine here, because the node installation's own bin directory holds
  # the shim and derive_agent_path will already have added it.
  [[ -x "$dir/$tool" ]] || return 0
  printf '%s' "$dir"
}

# The major version package.json's `engines.node` allows, or nothing if it cannot be read.
# Only the major is compared: a full semver-range check would need a semver implementation,
# and the failure this exists to catch — a system node from a different major — does not
# need one.
required_node_major() {
  local range
  range="$(sed -n 's/.*"node": *"\([^"]*\)".*/\1/p' "$MAIN_REPO/package.json" 2>/dev/null | head -1)"
  printf '%s' "$range" | sed -n 's/^[^0-9]*\([0-9][0-9]*\).*/\1/p'
}

# Build the PATH the agent should carry. A directory is added only when nothing already on
# the list provides that tool, which is what keeps the corepack case above from adding an
# ephemeral shim directory: node's installation bin holds `pnpm` too, and it comes first.
derive_agent_path() {
  local entries=() tool dir joined want_major have_major
  want_major="$(required_node_major)"

  for tool in "${AGENT_REQUIRED_TOOLS[@]}"; do
    joined="$(IFS=:; printf '%s' "${entries[*]:-}:${AGENT_SYSTEM_PATH[*]}")"
    if path_provides "$joined" "$tool"; then
      # Already reachable — but for node, reachable is not the same as correct.
      if [[ "$tool" != node || -z "$want_major" ]]; then continue; fi
      have_major="$(env -i PATH="$joined" HOME="$HOME" node --version 2>/dev/null |
        sed -n 's/^v\([0-9][0-9]*\).*/\1/p')"
      [[ "$have_major" == "$want_major" ]] && continue
    fi
    dir="$(stable_tool_dir "$tool")"
    [[ -n "$dir" && -d "$dir" ]] || continue
    entries+=("$dir")
  done

  (IFS=:; printf '%s' "${entries[*]:+${entries[*]}:}${AGENT_SYSTEM_PATH[*]}")
}

# Prove the derived PATH before it is written into a plist. Runs each tool from an EMPTY
# environment, because that is the environment launchd will use — a check that inherits this
# shell's PATH proves nothing. Returns 1 and explains, rather than emitting a plist that
# loads cleanly and then fails at 3am.
verify_agent_path() {
  local candidate="$1" tool missing=() want_major have_major
  for tool in "${AGENT_REQUIRED_TOOLS[@]}"; do
    env -i PATH="$candidate" HOME="$HOME" sh -c "command -v $tool" >/dev/null 2>&1 ||
      missing+=("$tool")
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    cat >&2 <<EOF
ERROR: the LaunchAgent PATH this would emit cannot find: ${missing[*]}

  PATH: $candidate

The desktop build shells out to all of ${AGENT_REQUIRED_TOOLS[*]}. A LaunchAgent gets no
login shell, so anything installed only via a shell profile is invisible to it — and a
missing tool does not fail loudly, it makes every tick back off in silence.

Install the missing tool somewhere permanent, or add its directory to AGENT_SYSTEM_PATH in
$(basename "$0"). No plist was emitted; re-run with --force to emit it anyway.
EOF
    return 1
  fi

  want_major="$(required_node_major)"
  [[ -n "$want_major" ]] || return 0
  have_major="$(env -i PATH="$candidate" HOME="$HOME" node --version 2>/dev/null |
    sed -n 's/^v\([0-9][0-9]*\).*/\1/p')"
  if [[ "$have_major" != "$want_major" ]]; then
    cat >&2 <<EOF
ERROR: the LaunchAgent PATH this would emit resolves node to major v${have_major:-?}, but
package.json's engines.node asks for v${want_major}.

  PATH: $candidate
  node: $(env -i PATH="$candidate" HOME="$HOME" sh -c 'command -v node' 2>/dev/null || echo '(none)')

This is the failure worth refusing over: the build would not break, it would SUCCEED against
the wrong toolchain and install the result. Install the pinned major so it is reachable from
an empty environment. No plist was emitted; re-run with --force to emit it anyway.
EOF
    return 1
  fi
  return 0
}

print_launchd() {
  # Refuse to hand back a plist that provably cannot run. Emitting one anyway is the worst
  # outcome: `launchctl bootstrap` succeeds, `launchctl print` reports the job as loaded,
  # and the only evidence of failure is `last exit code = 126` — so it looks installed and
  # silently never builds anything.
  local protected
  if protected="$(tcc_protected_path "$SCRIPT_DIR")"; then
    if [[ $FORCE -eq 0 ]]; then
      cat >&2 <<EOF
ERROR: this repo lives inside a macOS TCC-protected folder, so a LaunchAgent cannot run it.

  repo:      $REPO
  protected: $protected

launchd jobs get no TCC grant and never trigger a consent prompt — macOS just returns
EPERM. The agent would load, fail immediately with exit code 126, and build nothing:

  shell-init: error retrieving current directory: getcwd: ... Operation not permitted
  /bin/bash: $SCRIPT_DIR/auto-build-desktop.sh: Operation not permitted

No plist was emitted. Pick one:

  1. Move the repo out of the protected folder (recommended — no security grant):
       mkdir -p "\$HOME/Developer"
       mv "$REPO" "\$HOME/Developer/$(basename "$REPO")"
       git -C "\$HOME/Developer/$(basename "$REPO")" worktree repair   # if you use worktrees
     then re-run --print-launchd from the new location.

  2. Grant Full Disk Access to /bin/bash under System Settings > Privacy & Security
     (Cmd+Shift+G to reach /bin). This grants FDA to EVERY bash script on the machine —
     broad and permanent; not recommended for this.

  3. Skip launchd entirely and run the watcher in a terminal:
       $SCRIPT_DIR/auto-build-desktop.sh --watch --install --interval $INTERVAL

If you redirected stdout to a .plist, that file is now empty — delete it.
Re-run with --force to emit the plist anyway (it will not work).
EOF
      exit 2
    fi
    log "WARNING: repo is under $protected (TCC-protected); this agent will fail with exit 126"
  fi

  # Derived from the tools actually resolvable here, then re-checked from an empty
  # environment. See the block above for why this is not a hardcoded list.
  local agent_path
  agent_path="$(derive_agent_path)"
  if ! verify_agent_path "$agent_path" && [[ $FORCE -eq 0 ]]; then
    exit 2
  fi

  local label="dev.coil.autobuild"
  local x_script x_repo x_log x_path
  x_script="$(xml_escape "$SCRIPT_DIR/auto-build-desktop.sh")"
  x_path="$(xml_escape "$agent_path")"
  # MAIN_REPO, not REPO: in ref mode REPO is the build worktree, which may not exist
  # until the first tick — and launchd refuses to spawn a job whose WorkingDirectory
  # is missing.
  x_repo="$(xml_escape "$MAIN_REPO")"
  x_log="$(xml_escape "$LOG_FILE")"
  # These MUST be emitted. The plist's own StandardOutPath/marker paths are derived from
  # these vars, so without them a plist generated from a shell that overrode
  # T3X_AUTOBUILD_APPLICATIONS_DIR (e.g. while testing against a temp dir) produces an
  # agent that installs into the REAL /Applications, and one that overrode STATE_DIR
  # produces an agent logging to the custom path while writing its marker to the default.
  local x_state x_apps x_out
  x_state="$(xml_escape "$STATE_DIR")"
  x_apps="$(xml_escape "$APPLICATIONS_DIR")"
  x_out="$(xml_escape "$OUTPUT_DIR")"
  # blank-line filter: the optional-flag command substitutions below leave empty
  # lines behind when their flag is off.
  cat <<PLIST | grep -v '^[[:space:]]*$'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${x_script}</string>
    <string>--watch</string>
    <string>--interval</string>
    <string>${INTERVAL}</string>
$( [[ -n "$BUILD_REF" ]] && printf '    <string>--ref</string>\n    <string>%s</string>' "$(xml_escape "$BUILD_REF")" || true )
$( [[ $DO_INSTALL -eq 1 ]] && printf '    <string>--install</string>' || true )
$( [[ $DO_RELAUNCH -eq 1 ]] && printf '    <string>--relaunch</string>' || true )
  </array>
  <key>RunAtLoad</key><true/>
  <key>WorkingDirectory</key><string>${x_repo}</string>
  <key>StandardOutPath</key><string>${x_log}</string>
  <key>StandardErrorPath</key><string>${x_log}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${x_path}</string>
    <!-- corepack provides pnpm here, and package.json pins a packageManager version. With
         no tty a download prompt has nobody to answer it, so turn it off rather than let a
         tick hang on a question. NOTE: this heredoc is unquoted, so backticks in these
         comments would be command substitution, not prose. -->
    <key>COREPACK_ENABLE_DOWNLOAD_PROMPT</key><string>0</string>
    <key>T3X_AUTOBUILD_STATE_DIR</key><string>${x_state}</string>
    <key>T3X_AUTOBUILD_APPLICATIONS_DIR</key><string>${x_apps}</string>
    <key>T3CODE_DESKTOP_OUTPUT_DIR</key><string>${x_out}</string>
    <key>T3X_AUTOBUILD_KEEP_DMGS</key><string>${KEEP_DMGS}</string>
$( [[ -n "$BUILD_REF" ]] && printf '    <key>T3X_AUTOBUILD_WORKTREE</key><string>%s</string>' "$(xml_escape "$BUILD_WT")" || true )
    <!-- StandardOutPath and StandardErrorPath above are the SAME file, so log() must not
         also echo to stderr or every line is written twice. See the logging section. -->
    <key>T3X_AUTOBUILD_STDERR_IS_LOG</key><string>1</string>
  </dict>
</dict>
</plist>
PLIST
}

# --- watch loop --------------------------------------------------------------
watch_loop() {
  # Keep the Mac awake during overnight builds. Re-exec under caffeinate once.
  if [[ $CAFFEINATED -eq 0 ]] && command -v caffeinate >/dev/null 2>&1; then
    # Rebuild the FULL flag set, not a subset. Two bugs live here if you get it wrong:
    #
    #  * Dropping --dry-run/--force makes the re-exec'd process run for real, so
    #    `--watch --install --dry-run` — the exact command someone runs to preview the
    #    watcher — would quit the app and rm -rf /Applications/<app>.
    #  * Seeding the array empty and expanding "${arr[@]}" aborts under `set -u` on bash
    #    3.2 (what macOS ships), so `--watch` with no other flag died before its first
    #    poll. Seeding it with --watch keeps it non-empty, which sidesteps that entirely.
    local args=(--watch --interval "$INTERVAL" --_caffeinated)
    [[ -n "$BUILD_REF" ]] && args+=(--ref "$BUILD_REF")
    [[ $DO_INSTALL -eq 1 ]] && args+=(--install)
    [[ $DO_RELAUNCH -eq 1 ]] && args+=(--relaunch)
    [[ $DRY_RUN -eq 1 ]] && args+=(--dry-run)
    [[ $FORCE -eq 1 ]] && args+=(--force)
    log "re-exec under caffeinate -s"
    exec caffeinate -s "$0" "${args[@]}"
  fi
  log "watch: polling HEAD every ${INTERVAL}s (install=$DO_INSTALL)"
  local fails=0 rc delay
  while true; do
    rc=0
    build_once_locked || rc=$?
    # 0 = built, 3 = nothing to do. Anything else is a real failure.
    if [[ $rc -eq 0 || $rc -eq 3 ]]; then
      fails=0
    else
      fails=$((fails + 1))
    fi

    # Back off on repeated failure. Without this a persistent fault (unwritable
    # /Applications on a managed Mac, a full disk, a committed type error) means a full
    # multi-minute rebuild every INTERVAL seconds, all night, forever.
    delay="$INTERVAL"
    if (( fails > 0 )); then
      local mult=$(( 1 << (fails > 5 ? 5 : fails) ))   # 2x,4x,8x,16x,32x then flat
      delay=$(( INTERVAL * mult ))
      # Cap the backoff so a persistent failure can't rebuild forever — but never below
      # the poll interval. On the 12h cadence a flat 30-min cap would retry a failing
      # build ~48x/day, exactly the "stop constantly building" case this avoids; on a
      # short interval it still tops out at 30 min.
      local cap=$(( INTERVAL > 1800 ? INTERVAL : 1800 ))
      (( delay > cap )) && delay="$cap"
      log "watch: ${fails} consecutive failure(s); next attempt in ${delay}s"
    fi
    # `|| true`: a sleep interrupted by a signal must not kill the watcher under errexit.
    sleep "$delay" || true
  done
}

# Serialises the whole build+install+marker sequence against another instance.
build_once_locked() {
  if ! acquire_lock; then
    log "another auto-build is already running; skipping this tick"
    return 3
  fi
  local rc=0
  build_once || rc=$?
  release_lock
  trap - EXIT
  return "$rc"
}

# --- main --------------------------------------------------------------------
if [[ "${PRINT_LAUNCHD:-0}" -eq 1 ]]; then
  print_launchd
  exit 0
fi

# launchd keeps the copy of the plist it was bootstrapped with, so a fix to what
# --print-launchd emits does not reach a running agent — and nothing anywhere reports the
# gap. That is how the live agent came to carry a hand-edited PATH the generator did not
# know about for eleven days. This is the check that would have caught it.
if [[ "${DIFF_LAUNCHD:-0}" -eq 1 ]]; then
  installed="$HOME/Library/LaunchAgents/dev.coil.autobuild.plist"
  if [[ ! -f "$installed" ]]; then
    echo "No agent installed at $installed — nothing to diff." >&2
    exit 2
  fi
  # Comments are the divergence least worth reporting: the emitter writes some, and whoever
  # hand-edits the live plist writes more. Compare the settings, not the prose. The
  # single-line substitution runs BEFORE the range delete on purpose — otherwise a
  # self-contained `<!-- … -->` opens a range that swallows everything up to the next one.
  plist_settings_only() { sed -e 's/<!--.*-->//' -e '/<!--/,/-->/d' | grep -v '^[[:space:]]*$'; }
  generated="$(print_launchd)"   # exits 2 by itself if the PATH does not verify
  if diff -u \
    --label "installed: $installed" \
    --label "would emit: $0 ${ORIGINAL_ARGV[*]:-}" \
    <(plist_settings_only < "$installed") \
    <(printf '%s\n' "$generated" | plist_settings_only); then
    echo "The installed agent matches what this script would emit."
    exit 0
  fi
  cat >&2 <<EOF

The installed agent and this script disagree. If the installed side is the one that is
right, the fix belongs in --print-launchd — a hand-edit to the live plist is lost the next
time anyone regenerates it. To adopt this script's version:

  launchctl bootout "gui/\$UID/dev.coil.autobuild"
  $0 --print-launchd ${ORIGINAL_ARGV_NO_DIFF[*]:-} > "$installed"
  launchctl bootstrap "gui/\$UID" "$installed"
EOF
  exit 1
fi

if [[ $DO_WATCH -eq 1 ]]; then
  watch_loop
else
  build_once_locked
fi
