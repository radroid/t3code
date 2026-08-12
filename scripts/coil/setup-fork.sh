#!/usr/bin/env bash
#
# coil fork setup — idempotent, reversible.
#
# Establishes the remote/branch layout and git config described in
# docs/superpowers/specs/2026-07-23-fork-upstream-sync-design.md (A1, A3).
#
#   upstream -> pingdotgg/t3code   (fetch only; push disabled)
#   origin   -> radroid/t3code     (fetch + push; the fork)
#   main tracks origin/main; rerere enabled so resolved conflicts replay.
#
# Usage:
#   scripts/coil/setup-fork.sh                 # configure remotes + rerere
#   scripts/coil/setup-fork.sh --disable-workflows   # also disable inherited fork workflows (needs gh)
#   scripts/coil/setup-fork.sh --check         # report state, change nothing
#
set -euo pipefail

UPSTREAM_URL="https://github.com/pingdotgg/t3code.git"
FORK_URL_SSH="git@github.com:radroid/t3code.git"
FORK_URL_HTTPS="https://github.com/radroid/t3code.git"
FORK_SLUG="radroid/t3code"

CHECK_ONLY=0
DISABLE_WORKFLOWS=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --disable-workflows) DISABLE_WORKFLOWS=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

info()  { printf '\033[36m•\033[0m %s\n' "$*"; }
ok()    { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m!\033[0m %s\n' "$*"; }

remote_url() { git remote get-url "$1" 2>/dev/null || true; }

# Resolve the fork's push URL, preferring the existing scheme if already set.
resolve_fork_url() {
  local existing
  existing="$(remote_url origin)"
  if [[ "$existing" == git@github.com:* ]]; then echo "$FORK_URL_SSH"; else echo "$FORK_URL_HTTPS"; fi
}

report_state() {
  info "Current remotes:"
  git remote -v | sed 's/^/    /'
  info "rerere.enabled = $(git config --get rerere.enabled || echo '(unset)')"
  info "rerere.autoupdate = $(git config --get rerere.autoupdate || echo '(unset)')"
  info "main upstream tracking = $(git config --get branch.main.remote || echo '(unset)')/$(git config --get branch.main.merge | sed 's#refs/heads/##' || echo '?')"
}

if [[ "$CHECK_ONLY" == 1 ]]; then
  report_state
  exit 0
fi

# --- A1: remotes -------------------------------------------------------------
FORK_URL="$(resolve_fork_url)"

# `upstream` must point at pingdotgg for fetch, with push disabled.
if [[ "$(remote_url upstream)" != "$UPSTREAM_URL" ]]; then
  # A pre-existing `origin`/`fork` may already point at these URLs under old names.
  if git remote | grep -qx upstream; then
    git remote set-url upstream "$UPSTREAM_URL"
  else
    git remote add upstream "$UPSTREAM_URL"
  fi
fi
# Disable pushing to upstream (belt-and-suspenders against accidental push).
git remote set-url --push upstream DISABLE_PUSH_TO_UPSTREAM
ok "upstream -> $UPSTREAM_URL (push disabled)"

# `origin` must be the fork for both fetch and push.
if [[ "$(remote_url origin)" != "$FORK_URL_HTTPS" && "$(remote_url origin)" != "$FORK_URL_SSH" ]]; then
  if git remote | grep -qx origin; then
    git remote set-url origin "$FORK_URL"
  else
    git remote add origin "$FORK_URL"
  fi
fi
ok "origin -> $(remote_url origin)"

# Drop the legacy `fork` remote if it duplicates origin, to avoid confusion.
if git remote | grep -qx fork; then
  fork_url="$(remote_url fork)"
  if [[ "$fork_url" == "$FORK_URL_HTTPS" || "$fork_url" == "$FORK_URL_SSH" ]]; then
    git remote remove fork
    ok "removed redundant legacy 'fork' remote (now 'origin')"
  else
    warn "legacy 'fork' remote points elsewhere ($fork_url); left untouched"
  fi
fi

# --- A1: rerere + main tracking ---------------------------------------------
git config rerere.enabled true
git config rerere.autoupdate true
ok "rerere enabled + autoupdate"

git fetch upstream --quiet || warn "could not fetch upstream (offline?); tracking left as-is"
if git rev-parse --verify --quiet origin/main >/dev/null; then
  git branch --set-upstream-to=origin/main main >/dev/null 2>&1 || true
  ok "main tracks origin/main"
fi

# --- A3: neutralize inherited fork workflows --------------------------------
if [[ "$DISABLE_WORKFLOWS" == 1 ]]; then
  if ! command -v gh >/dev/null; then
    warn "gh not found; skipping workflow disable. Run manually:"
    echo "    for f in ci.yml deploy-relay.yml issue-labels.yml mobile-eas-preview.yml \\"
    echo "             mobile-eas-production.yml mobile-showcase-screenshots.yml pr-size.yml \\"
    echo "             pr-vouch.yml release.yml; do gh workflow disable \"\$f\" -R $FORK_SLUG; done"
  else
    info "Disabling inherited upstream workflows on $FORK_SLUG ..."
    for f in ci.yml deploy-relay.yml issue-labels.yml mobile-eas-preview.yml \
             mobile-eas-production.yml mobile-showcase-screenshots.yml pr-size.yml \
             pr-vouch.yml release.yml; do
      gh workflow disable "$f" -R "$FORK_SLUG" 2>/dev/null && ok "disabled $f" || warn "could not disable $f (already disabled or absent)"
    done
    warn "The two coil workflows are intentionally left enabled."
  fi
else
  info "Skipping workflow disable (pass --disable-workflows to do it, or run gh manually)."
fi

echo
report_state
echo
ok "Fork setup complete. To undo: git remote rename / 'gh workflow enable <file>'."
