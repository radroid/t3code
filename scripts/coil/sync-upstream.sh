#!/usr/bin/env bash
#
# coil upstream sync — merge upstream/main into the fork's main and verify.
#
# Implements the mechanical core of A4 (daily sync), as amended 2026-09-02: the fork MERGES
# upstream rather than rebasing onto it. `main` only ever fast-forwards, no step rewrites
# history and no step force-pushes, so worktrees, tags, open PRs and in-flight branches all
# stay anchored. Locally testable and reused by .github/workflows/coil-upstream-sync.yml.
# Writes a machine-readable status file and uses exit codes so a caller (workflow or agent)
# can decide whether to push / escalate.
#
#   exit 0  = clean merge, verification green  -> caller may push (a plain fast-forward)
#   exit 10 = upstream unchanged, nothing to do (no-op)
#   exit 20 = merge conflict (merge aborted, working tree restored, nothing pushed)
#   exit 30 = merge clean but verification failed (nothing pushed)
#
# There is no dropped-patch exit any more (it used to be 40). A rebase replays each fork
# commit and can silently drop one that upstream absorbed; a merge replays nothing, so every
# fork commit stays reachable from `main` by construction and there is nothing to detect.
#
# Status file (default: ./coil-sync-status.json) always written before exit.
#
# Env:
#   UPSTREAM_REMOTE   (default: upstream)
#   UPSTREAM_BRANCH   (default: main)
#   LOCAL_BRANCH      (default: main)
#   RUN               command prefix for package scripts (default: "vp run")
#   VERIFY            space-separated script names (default: "typecheck lint test")
#   STATUS_FILE       (default: ./coil-sync-status.json)
#   SKIP_VERIFY=1     merge only, skip verification (used by callers that verify separately)
#
set -uo pipefail

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
LOCAL_BRANCH="${LOCAL_BRANCH:-main}"
RUN="${RUN:-vp run}"
VERIFY="${VERIFY:-typecheck lint test}"
STATUS_FILE="${STATUS_FILE:-./coil-sync-status.json}"
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

# Patch manifest = the fork's own commits, i.e. everything on local that upstream does not
# have. --no-merges drops the sync merges themselves, which are not fork changes; the list is
# the same before and after a merge, since a merge never rewrites a commit.
MANIFEST="$(git log --oneline --no-merges "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH..$LOCAL_BRANCH" | head -100 || true)"

# --- no-op if upstream hasn't advanced beyond our merge base ----------------
if [[ "$MERGE_BASE" == "$UPSTREAM_HEAD" ]]; then
  echo "→ upstream unchanged since last sync; nothing to do"
  write_status daily noop "upstream/$UPSTREAM_BRANCH already merged"
  exit 10
fi

UPSTREAM_RANGE="$(git log --oneline "$MERGE_BASE..$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" | head -100 || true)"
UPSTREAM_COUNT="$(git rev-list --count "$MERGE_BASE..$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" || echo 0)"
FORK_COUNT="$(git rev-list --count --no-merges "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH..$LOCAL_BRANCH" || echo 0)"

echo "→ merging $UPSTREAM_REMOTE/$UPSTREAM_BRANCH ($UPSTREAM_COUNT commits) into $LOCAL_BRANCH ($FORK_COUNT fork commits)"
# Checked, not assumed. An unclean tree (or a missing branch) makes this fail, and an unchecked
# failure leaves the script merging into whatever branch happened to be out — then reporting ok.
git checkout -q "$LOCAL_BRANCH" || {
  FAILING_STEP="checkout"
  write_status daily error "could not check out $LOCAL_BRANCH"
  exit 1
}

# --no-ff so the sync is always one reviewable merge commit with a subject that names the
# absorbed range, even in the degenerate case where the fork has nothing of its own left.
MERGE_MSG="chore(coil): merge $UPSTREAM_REMOTE/$UPSTREAM_BRANCH $(git rev-parse --short "$UPSTREAM_HEAD") ($UPSTREAM_COUNT commits)"

if ! git merge --no-ff -m "$MERGE_MSG" "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"; then
  CONFLICTED="$(git diff --name-only --diff-filter=U | sort -u | tr '\n' ' ')"
  # Which upstream commits touched the conflicted files (the likely culprits).
  if [[ -n "$CONFLICTED" ]]; then
    # shellcheck disable=SC2086
    CULPRITS="$(git log --oneline "$MERGE_BASE..$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" -- $CONFLICTED | head -40 || true)"
  fi
  git merge --abort || true
  fail "merge conflict in: $CONFLICTED"
  # `git merge --abort` restores the pre-merge tree, but it can itself fail. Confirm the merge
  # really is gone before claiming it: nothing pushes either way, but a half-aborted merge left
  # in the checkout is the one outcome a human has to be told about. Only merge residue counts —
  # an unrelated local edit is not this script's business to report or to clean up.
  if [[ -n "$(git ls-files --unmerged)" ]] || [[ -e "$(git rev-parse --git-path MERGE_HEAD)" ]]; then
    fail "merge --abort did not restore the checkout; it is still mid-merge. Recover by hand ('git merge --abort', or 'git reset --hard $LOCAL_HEAD' if you have nothing else in the tree)"
    write_status daily conflict "merge aborted but the checkout is still mid-merge; needs manual recovery to $LOCAL_HEAD"
    exit 20
  fi
  write_status daily conflict "merge aborted; working tree restored"
  exit 20
fi

# --- verify ------------------------------------------------------------------
if [[ "$SKIP_VERIFY" == 1 ]]; then
  echo "→ SKIP_VERIFY set; merge clean, leaving verification to caller"
  write_status daily merged "merge clean; verification skipped"
  exit 0
fi

# Per-script extra args, so the daily verify matches the fork's CI gate exactly. `test` needs
# --testTimeout because apps/web pins 15s (tuned for upstream's blacksmith runners) and this fork
# runs on 2-core ubuntu-latest, where an upstream CPU-bound test reliably blows it. 120s is the
# highest any package configures (apps/server), so it never LOWERS a package's own budget.
# --hookTimeout is the same fix for the same reason and is NOT implied by --testTimeout: a
# beforeAll/beforeEach carries its own budget, and an upstream web test timed out in one under
# full-suite load at the 2026-08-02 sync while passing standalone.
# Keep in sync with `.github/workflows/coil-ci.yml`.
for script in $VERIFY; do
  EXTRA=""
  if [[ "$script" == "test" ]]; then EXTRA="--testTimeout=120000 --hookTimeout=120000"; fi
  echo "→ verify: $RUN $script $EXTRA"
  # shellcheck disable=SC2086
  if ! $RUN "$script" $EXTRA; then
    FAILING_STEP="$script"
    fail "verification step '$script' failed"
    write_status daily verify-failed "merge clean but '$script' failed"
    exit 30
  fi
done

write_status daily ok "merge clean and verification green"
echo "✓ sync clean and verified"
exit 0
