#!/usr/bin/env bash
#
# t3x upstream sync — rebase the fork's patch series onto upstream/main and verify.
#
# Implements the mechanical core of A4 (daily sync). Locally testable and reused by
# .github/workflows/t3x-upstream-sync.yml. Writes a machine-readable status file and
# uses exit codes so a caller (workflow or agent) can decide whether to push / escalate.
#
#   exit 0  = clean rebase, verification green  -> caller may push
#   exit 10 = upstream unchanged, nothing to do (no-op)
#   exit 20 = rebase conflict (working tree restored, nothing pushed)
#   exit 30 = rebase clean but verification failed (nothing pushed)
#   exit 40 = rebase clean & verification green, but a fork patch was dropped during
#            rebase (upstream likely absorbed it) -> needs review, nothing pushed
#
# Status file (default: ./t3x-sync-status.json) always written before exit.
#
# Env:
#   UPSTREAM_REMOTE   (default: upstream)
#   UPSTREAM_BRANCH   (default: main)
#   LOCAL_BRANCH      (default: main)
#   RUN               command prefix for package scripts (default: "vp run")
#   VERIFY            space-separated script names (default: "typecheck lint test")
#   STATUS_FILE       (default: ./t3x-sync-status.json)
#   SKIP_VERIFY=1     rebase only, skip verification (used by callers that verify separately)
#
set -uo pipefail

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
LOCAL_BRANCH="${LOCAL_BRANCH:-main}"
RUN="${RUN:-vp run}"
VERIFY="${VERIFY:-typecheck lint test}"
STATUS_FILE="${STATUS_FILE:-./t3x-sync-status.json}"
SKIP_VERIFY="${SKIP_VERIFY:-0}"

# --- json status helper (no jq dependency) ----------------------------------
json_escape() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' <<<"$1"; }

write_status() {
  # args: kind result [detail]
  local kind="$1" result="$2" detail="${3:-}"
  {
    printf '{\n'
    printf '  "kind": "daily",\n'
    printf '  "result": "%s",\n' "$result"
    printf '  "upstream_range": %s,\n' "$(json_escape "${UPSTREAM_RANGE:-}")"
    printf '  "upstream_head": %s,\n' "$(json_escape "${UPSTREAM_HEAD:-}")"
    printf '  "conflicted_files": %s,\n' "$(json_escape "${CONFLICTED:-}")"
    printf '  "culprit_commits": %s,\n' "$(json_escape "${CULPRITS:-}")"
    printf '  "failing_step": %s,\n' "$(json_escape "${FAILING_STEP:-}")"
    printf '  "dropped_patches": %s,\n' "$(json_escape "${DROPPED:-}")"
    printf '  "patch_manifest": %s,\n' "$(json_escape "${MANIFEST:-}")"
    printf '  "detail": %s\n' "$(json_escape "$detail")"
    printf '}\n'
  } >"$STATUS_FILE"
}

fail() { echo "ERROR: $*" >&2; }

command -v git >/dev/null || { fail "git not found"; exit 1; }

# --- fetch upstream ----------------------------------------------------------
echo "→ fetching $UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
if ! git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH" --tags --quiet; then
  FAILING_STEP="fetch"
  write_status daily error "could not fetch $UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
  exit 1
fi

UPSTREAM_HEAD="$(git rev-parse "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH")"
LOCAL_HEAD="$(git rev-parse "$LOCAL_BRANCH")"
MERGE_BASE="$(git merge-base "$LOCAL_BRANCH" "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH")"

# Patch manifest = commits on local not in upstream (before rebase).
MANIFEST="$(git log --oneline "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH..$LOCAL_BRANCH" || true)"

# --- no-op if upstream hasn't advanced beyond our merge base ----------------
if [[ "$MERGE_BASE" == "$UPSTREAM_HEAD" ]]; then
  echo "→ upstream unchanged since last sync; nothing to do"
  write_status daily noop "upstream/$UPSTREAM_BRANCH already merged"
  exit 10
fi

UPSTREAM_RANGE="$(git log --oneline "$MERGE_BASE..$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" | head -100 || true)"
# --no-merges: a default `git rebase` flattens merge commits, so counting them would make
# PATCH_COUNT_AFTER < BEFORE even when no real patch was dropped (e.g. a t3x PR merged into
# fork main via GitHub's merge button) — a false "dropped patch" that would stall the sync
# every day. Counting only non-merge commits is invariant across that flattening while
# still catching a genuinely dropped patch (a real commit that upstream absorbed).
PATCH_COUNT_BEFORE="$(git rev-list --count --no-merges "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH..$LOCAL_BRANCH" || echo 0)"

echo "→ rebasing $LOCAL_BRANCH ($PATCH_COUNT_BEFORE patch commits) onto $UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
git checkout -q "$LOCAL_BRANCH"

if ! git rebase "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"; then
  CONFLICTED="$(git diff --name-only --diff-filter=U | sort -u | tr '\n' ' ')"
  # Which upstream commits touched the conflicted files (the likely culprits).
  if [[ -n "$CONFLICTED" ]]; then
    # shellcheck disable=SC2086
    CULPRITS="$(git log --oneline "$MERGE_BASE..$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" -- $CONFLICTED | head -40 || true)"
  fi
  git rebase --abort || true
  fail "rebase conflict in: $CONFLICTED"
  write_status daily conflict "rebase aborted; working tree restored"
  exit 20
fi

# --- dropped-patch detection (A4 step 7) ------------------------------------
# Compare non-merge counts (see PATCH_COUNT_BEFORE above) so merge-flattening never
# false-positives.
PATCH_COUNT_AFTER="$(git rev-list --count --no-merges "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH..$LOCAL_BRANCH" || echo 0)"
if (( PATCH_COUNT_AFTER < PATCH_COUNT_BEFORE )); then
  DROPPED="non-merge patch count dropped $PATCH_COUNT_BEFORE -> $PATCH_COUNT_AFTER (upstream likely absorbed a change); manifest before: $MANIFEST"
  fail "$DROPPED"
fi

# --- verify ------------------------------------------------------------------
if [[ "$SKIP_VERIFY" == 1 ]]; then
  # A dropped patch must escalate even when the caller verifies separately: it means a
  # fork commit silently vanished, which is never safe to auto-push.
  if [[ -n "${DROPPED:-}" ]]; then
    write_status daily dropped-patch "rebase clean; verification skipped; a fork patch was dropped"
    exit 40
  fi
  echo "→ SKIP_VERIFY set; rebase clean, leaving verification to caller"
  write_status daily rebased "rebase clean; verification skipped"
  exit 0
fi

# Per-script extra args, so the daily verify matches the fork's CI gate exactly. `test` needs
# --testTimeout because apps/web pins 15s (tuned for upstream's blacksmith runners) and this fork
# runs on 2-core ubuntu-latest, where an upstream CPU-bound test reliably blows it. 120s is the
# highest any package configures (apps/server), so it never LOWERS a package's own budget.
# --hookTimeout is the same fix for the same reason and is NOT implied by --testTimeout: a
# beforeAll/beforeEach carries its own budget, and an upstream web test timed out in one under
# full-suite load at the 2026-08-02 sync while passing standalone.
# Keep in sync with `.github/workflows/t3x-ci.yml`.
for script in $VERIFY; do
  EXTRA=""
  if [[ "$script" == "test" ]]; then EXTRA="--testTimeout=120000 --hookTimeout=120000"; fi
  echo "→ verify: $RUN $script $EXTRA"
  # shellcheck disable=SC2086
  if ! $RUN "$script" $EXTRA; then
    FAILING_STEP="$script"
    fail "verification step '$script' failed"
    write_status daily verify-failed "rebase clean but '$script' failed"
    exit 30
  fi
done

# A green tree that dropped one of our own patches is still NOT safe to auto-push: the
# fork lost a change and a human/agent must confirm the loss was intentional. Escalate
# with a distinct code so the workflow opens an issue instead of pushing.
if [[ -n "${DROPPED:-}" ]]; then
  fail "escalating (exit 40): a fork patch was dropped during rebase; not auto-pushing"
  write_status daily dropped-patch "rebase clean and verification green, but a fork patch was dropped: $DROPPED"
  exit 40
fi

write_status daily ok "rebase clean and verification green"
echo "✓ sync clean and verified"
exit 0
