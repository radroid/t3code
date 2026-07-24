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

OUTPUT_DIR="${T3CODE_DESKTOP_OUTPUT_DIR:-$REPO/release}"
KEEP_DMGS="${T3X_AUTOBUILD_KEEP_DMGS:-3}"
APPLICATIONS_DIR="${T3X_AUTOBUILD_APPLICATIONS_DIR:-/Applications}"

# --- flags -------------------------------------------------------------------
DO_INSTALL=0
DO_RELAUNCH=0
DO_WATCH=0
DRY_RUN=0
FORCE=0
INTERVAL=60
CAFFEINATED=0

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

mkdir -p "$STATE_DIR" "$LOG_DIR"

# --- logging -----------------------------------------------------------------
now_iso() { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { printf '%s %s\n' "$(now_iso)" "$*" | tee -a "$LOG_FILE" >&2; }

# --- json status (no jq) -----------------------------------------------------
json_escape() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' <<<"${1-}"; }
write_status() {
  # args: result sha dmg detail
  local result="$1" sha="$2" dmg="$3" detail="${4:-}"
  {
    printf '{\n'
    printf '  "result": %s,\n' "$(json_escape "$result")"
    printf '  "sha": %s,\n' "$(json_escape "$sha")"
    printf '  "dmgPath": %s,\n' "$(json_escape "$dmg")"
    printf '  "builtAt": %s,\n' "$(json_escape "$(now_iso)")"
    printf '  "installed": %s,\n' "$([[ $DO_INSTALL -eq 1 && $DRY_RUN -eq 0 ]] && echo true || echo false)"
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
    [[ -n "$f" ]] && { log "prune old dmg: $f"; rm -f "$f"; }
  done <<<"$old"
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
  # Best-effort quit of the running app so we can replace it.
  osascript -e "quit app \"${appbase%.app}\"" >/dev/null 2>&1 || true

  if [[ $DRY_RUN -eq 1 ]]; then
    log "DRY-RUN would: rm -rf '$target' && cp -R '$app' '$target'"
    log "DRY-RUN would: xattr -dr com.apple.quarantine '$target'  (unsigned local build)"
    [[ $DO_RELAUNCH -eq 1 ]] && log "DRY-RUN would: open '$target'"
    return 0
  fi

  rm -rf "$target"
  cp -R "$app" "$target"
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
    if lockfile_changed "$last"; then
      log "pnpm-lock.yaml changed -> pnpm install --frozen-lockfile"
      ( cd "$REPO" && pnpm install --frozen-lockfile )
    fi
    log "ensuring electron runtime"
    ( cd "$REPO" && pnpm --filter @t3tools/desktop ensure:electron )
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

  if [[ $DO_INSTALL -eq 1 ]]; then
    install_dmg "$dmg" || log "install step failed (continuing)"
  fi

  if [[ $DRY_RUN -eq 0 ]]; then
    write_status "built" "$cur" "$dmg" "ok"
    printf '%s' "$cur" >"$LAST_SHA_FILE"   # advance marker only on a real successful build
    prune_dmgs
  fi
  return 0
}

# --- launchd plist emitter ---------------------------------------------------
print_launchd() {
  local label="dev.t3x.autobuild"
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
    <string>${SCRIPT_DIR}/auto-build-desktop.sh</string>
    <string>--watch</string>
    <string>--interval</string>
    <string>${INTERVAL}</string>
$( [[ $DO_INSTALL -eq 1 ]] && printf '    <string>--install</string>' || true )
$( [[ $DO_RELAUNCH -eq 1 ]] && printf '    <string>--relaunch</string>' || true )
  </array>
  <key>RunAtLoad</key><true/>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST
}

# --- watch loop --------------------------------------------------------------
watch_loop() {
  # Keep the Mac awake during overnight builds. Re-exec under caffeinate once.
  if [[ $CAFFEINATED -eq 0 ]] && command -v caffeinate >/dev/null 2>&1; then
    local extra=()
    [[ $DO_INSTALL -eq 1 ]] && extra+=(--install)
    [[ $DO_RELAUNCH -eq 1 ]] && extra+=(--relaunch)
    log "re-exec under caffeinate -s"
    exec caffeinate -s "$0" --watch --interval "$INTERVAL" "${extra[@]}" --_caffeinated
  fi
  log "watch: polling HEAD every ${INTERVAL}s (install=$DO_INSTALL)"
  while true; do
    if ! build_once; then
      # build_once returns 3 for no-op (fine) and 1 for failure — never crash the loop.
      :
    fi
    sleep "$INTERVAL"
  done
}

# --- main --------------------------------------------------------------------
if [[ "${PRINT_LAUNCHD:-0}" -eq 1 ]]; then
  print_launchd
  exit 0
fi

if [[ $DO_WATCH -eq 1 ]]; then
  watch_loop
else
  build_once
fi
