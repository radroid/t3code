#!/usr/bin/env bash
#
# t3x auto-build & install the macOS desktop app on change.
#
# Keeps the installed desktop app current: when the fork's HEAD moves to a new
# commit, rebuild the macOS arm64 .dmg and (optionally) install it — no manual
# dmg-dragging. See docs/t3x/auto-build-runbook.md for the full runbook.
#
# The build itself is the existing `pnpm dist:desktop:dmg:arm64` — this script
# never edits scripts/build-desktop-artifact.ts (a hot upstream file). Zero
# upstream seams: everything here lives under scripts/t3x/.
#
# Usage:
#   scripts/t3x/auto-build-desktop.sh                    # one-shot build if HEAD changed
#   scripts/t3x/auto-build-desktop.sh --force            # build even if HEAD unchanged
#   scripts/t3x/auto-build-desktop.sh --install          # build + install to /Applications
#   scripts/t3x/auto-build-desktop.sh --install --relaunch
#   scripts/t3x/auto-build-desktop.sh --install --dry-run # log the install steps, change nothing
#   scripts/t3x/auto-build-desktop.sh --watch [--interval 60] [--install]
#   scripts/t3x/auto-build-desktop.sh --print-launchd     # emit a ready-to-use LaunchAgent plist
#   scripts/t3x/auto-build-desktop.sh --help
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
#
set -euo pipefail

# --- resolve paths -----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"

STATE_DIR="${T3X_AUTOBUILD_STATE_DIR:-$HOME/.t3/userdata}"
LOG_DIR="$STATE_DIR/logs"
LAST_SHA_FILE="$STATE_DIR/t3x-autobuild-last-sha"
STATUS_FILE="$STATE_DIR/t3x-autobuild-status.json"
LOG_FILE="$LOG_DIR/t3x-autobuild.log"

# Match scripts/build-desktop-artifact.ts, which does `path.resolve(repoRoot, outputDir)`:
# a RELATIVE override is repo-relative there, so resolving it against $PWD here would make
# us search/prune the caller's ./<dir> and then report "no .dmg" for a build that succeeded.
OUTPUT_DIR="${T3CODE_DESKTOP_OUTPUT_DIR:-release}"
case "$OUTPUT_DIR" in
  /*) ;;                       # absolute override: use as-is
  *) OUTPUT_DIR="$REPO/$OUTPUT_DIR" ;;
esac
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
INTERVAL=60
CAFFEINATED=0
INSTALL_OK=0   # set only after an install actually succeeds; drives status JSON

usage() { grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//;s/^#$//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) DO_INSTALL=1 ;;
    --relaunch) DO_RELAUNCH=1 ;;
    --watch) DO_WATCH=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --interval) INTERVAL="${2:?--interval needs a value}"; shift ;;
    --interval=*) INTERVAL="${1#*=}" ;;
    --print-launchd) PRINT_LAUNCHD=1 ;;
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

mkdir -p "$STATE_DIR" "$LOG_DIR"

# --- logging -----------------------------------------------------------------
now_iso() { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { printf '%s %s\n' "$(now_iso)" "$*" | tee -a "$LOG_FILE" >&2; }

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
current_sha() { git -C "$REPO" rev-parse HEAD; }
read_last_sha() { [[ -f "$LAST_SHA_FILE" ]] && cat "$LAST_SHA_FILE" || printf ''; }

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
LOCK_DIR="$STATE_DIR/t3x-autobuild.lock"

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

# --- install -----------------------------------------------------------------
install_dmg() {
  local dmg="$1"
  [[ -z "$dmg" || ! -f "$dmg" ]] && { log "install: no .dmg to install ($dmg)"; return 1; }

  local mnt app appbase target
  mnt="$(mktemp -d "${TMPDIR:-/tmp}/t3x-dmg.XXXXXX")"
  # shellcheck disable=SC2064
  trap "hdiutil detach '$mnt' -quiet >/dev/null 2>&1 || true; rmdir '$mnt' 2>/dev/null || true" RETURN

  if [[ $DRY_RUN -eq 1 ]]; then
    log "DRY-RUN install: hdiutil attach '$dmg' -> '$mnt'"
  else
    hdiutil attach -nobrowse -quiet "$dmg" -mountpoint "$mnt"
  fi

  # In dry-run we can't read the mount, so infer the app name from env or default.
  if [[ $DRY_RUN -eq 1 ]]; then
    appbase="${T3X_AUTOBUILD_APP_NAME:-T3 Code}.app"
    app="$mnt/$appbase"
  else
    app="$(find "$mnt" -maxdepth 1 -name '*.app' | head -1)"
    [[ -z "$app" ]] && { log "install: no .app found in $dmg"; return 1; }
    appbase="$(basename "$app")"
  fi
  target="$APPLICATIONS_DIR/$appbase"

  log "install: '$appbase' -> '$target'"

  # NOTE: the dry-run return must come BEFORE the quit below. `osascript quit` is a real
  # side effect on the user's session, so running it here would make `--install --dry-run`
  # close their running app — exactly what a dry run promises not to do.
  if [[ $DRY_RUN -eq 1 ]]; then
    log "DRY-RUN would: quit app '${appbase%.app}'"
    log "DRY-RUN would: rm -rf '$target' && cp -R '$app' '$target'"
    log "DRY-RUN would: xattr -dr com.apple.quarantine '$target'  (unsigned local build)"
    [[ $DO_RELAUNCH -eq 1 ]] && log "DRY-RUN would: open '$target'"
    return 0
  fi

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
  local staged="$target.t3x-new"
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
  cur="$(current_sha)"
  last="$(read_last_sha)"

  if [[ "$cur" == "$last" && $FORCE -eq 0 ]]; then
    log "no change since last build ($cur); nothing to do"
    return 3
  fi

  log "building desktop dmg for $cur (last built: ${last:-none})"

  if [[ $DRY_RUN -eq 1 ]]; then
    log "DRY-RUN would: pnpm dist:desktop:dmg:arm64  (cwd $REPO)"
  else
    # These are checked explicitly rather than relying on `set -e`: build_once is called as
    # `if ! build_once` by the watch loop, and bash disables errexit for the whole dynamic
    # extent of a function whose status is being tested. Without these checks a failed
    # install would fall through and the dmg would be built against stale dependencies.
    if lockfile_changed "$last"; then
      log "pnpm-lock.yaml changed -> pnpm install --frozen-lockfile"
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
    if ! ( cd "$REPO" && pnpm dist:desktop:dmg:arm64 ); then
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

print_launchd() {
  local label="dev.t3x.autobuild"
  local x_script x_repo x_log
  x_script="$(xml_escape "$SCRIPT_DIR/auto-build-desktop.sh")"
  x_repo="$(xml_escape "$REPO")"
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
$( [[ $DO_INSTALL -eq 1 ]] && printf '    <string>--install</string>' || true )
$( [[ $DO_RELAUNCH -eq 1 ]] && printf '    <string>--relaunch</string>' || true )
  </array>
  <key>RunAtLoad</key><true/>
  <key>WorkingDirectory</key><string>${x_repo}</string>
  <key>StandardOutPath</key><string>${x_log}</string>
  <key>StandardErrorPath</key><string>${x_log}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>T3X_AUTOBUILD_STATE_DIR</key><string>${x_state}</string>
    <key>T3X_AUTOBUILD_APPLICATIONS_DIR</key><string>${x_apps}</string>
    <key>T3CODE_DESKTOP_OUTPUT_DIR</key><string>${x_out}</string>
    <key>T3X_AUTOBUILD_KEEP_DMGS</key><string>${KEEP_DMGS}</string>
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
      (( delay > 1800 )) && delay=1800                  # never wait more than 30 min
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

if [[ $DO_WATCH -eq 1 ]]; then
  watch_loop
else
  build_once_locked
fi
