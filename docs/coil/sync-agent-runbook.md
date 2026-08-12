# t3x daily sync — conflict-resolver runbook

The daily GitHub Action (`t3x-upstream-sync.yml`) does the mechanical rebase every day for
free. When it **can't** complete — a merge conflict, a red verify, or a dropped patch — it
opens (or updates) a single `t3x-sync` issue with a status JSON block. This runbook is how that
issue gets resolved: **on demand, by activating an agent**. This resolver runs only when asked —
though `t3x-ci.yml` still gates every push and PR, and `t3x-weekly-verify.yml` runs on Sundays.

See the design specs `docs/superpowers/specs/2026-07-23-fork-upstream-sync-design.md` (the
daily/weekly sync + the `t3x-sync` escalation contract) and
`docs/superpowers/specs/2026-07-25-sync-conflict-agent-design.md` (this resolver).

## Activate the agent (the one action)

On the open `t3x-sync` issue, comment:

```
@claude resolve
```

That triggers `.github/workflows/t3x-sync-resolve.yml`, which runs Claude Code in CI to replay
the rebase, resolve the conflicts, run verify, and **open a PR into `main`**. It never pushes to
`main` — you review it and land it yourself (see [Landing a sync PR](#landing-a-sync-pr-do-not-use-the-github-merge-button)).
The agent comments the PR link back on the issue when done.

> **The comment path always uses `claude-sonnet-5`.** The `model` input only exists on manual
> dispatch, so `@claude resolve` cannot select a stronger model. For anything but a small range,
> dispatch it instead:
>
> ```
> gh workflow run "t3x sync resolve (agent)" -R radroid/t3code -f issue=<n> -f model=claude-opus-5
> ```

**Check the budget before you pick a path.** The job is capped at `timeout-minutes: 45` and
`--max-turns 150`. The one successful resolve to date absorbed a 36-commit upstream range against
37 fork patches and used 36m15s — 81% of the budget. A materially larger range will exhaust it, and
a timeout mid-rebase leaves an unpushed branch and a spent budget. Raising the caps needs a workflow
edit; `workflow_dispatch` reads the workflow file from `--ref`, so you can carry raised limits on a
scratch branch without merging it (the job still checks out and rebases `main`):

```
gh workflow run t3x-sync-resolve.yml -R radroid/t3code \
  --ref t3x/bigger-resolve-budget -f issue=<n> -f model=claude-opus-5
```

Measure the range first:

```
git fetch upstream
git rev-list --count $(git merge-base main upstream/main)..upstream/main   # upstream commits
git rev-list --count --no-merges upstream/main..main                       # fork patches to replay
```

### The daily job cannot trigger the resolver

Its escalation comment contains the literal `@claude resolve` string, but GitHub creates no workflow
run from a `GITHUB_TOKEN`-authored event, and `github-actions[bot]` reports `author_association:
NONE`, which fails the workflow's own permission check. Resolution is always human-initiated. Do not
"fix" the phrasing in the escalation body — it is the copy-pasteable instruction for the human.

A comment that fails the gate (missing `t3x-sync` label, wrong author, edited rather than newly
created) shows up in the Actions tab as **skipped**, not as an error. Check there if nothing happens.

### Not every `t3x-sync` issue is a rebase conflict

`t3x-weekly-verify.yml` escalates onto the _same_ label and issue with `**kind:** weekly-build`.
`@claude resolve` passes the full gate on those too and will spend an entire agent budget replaying
a rebase that is not the problem. Read the `**Result:**` / `**kind:**` line first; a `weekly-build`
failure means fix the build.

### A `push-failed` issue is not a conflict — do not send the agent

`**Result:** push-failed` means the rebase was clean and typecheck/lint/test were all green, and
then `git push --force-with-lease origin main` was rejected. Replaying the rebase fixes nothing;
fix the credential and re-run _t3x upstream sync (daily)_.

The dominant cause: **GitHub forbids `GITHUB_TOKEN` from creating or updating any file under
the `.github/workflows/` directory** — on `main` or on a branch. It is not grantable from the
workflow's `permissions:` block (there is no `workflows` key), so the only fix is pushing as
something else. Both sync workflows therefore check out with `secrets.T3X_SYNC_TOKEN` (see
[One-time setup](#one-time-setup)), falling back to `GITHUB_TOKEN` when it is unset.

This stayed invisible until 2026-08-11, when the absorbed range first included an upstream commit
that edited a workflow file (`1b120f352`, _fix(ci): extend release publish timeout_). Every sync
carrying an upstream CI change hits it. Nothing is force-landed when it happens: `origin/main` is
untouched and in-flight PRs stay mergeable, which is why re-running is safe.

### When verify goes red on code the fork does not own

A sync can import an upstream test that fails **in this fork's CI but not upstream's**, because
upstream runs on `blacksmith-*` runners and the fork runs on 2-core `ubuntu-latest`. Before treating
a red verify as a bad rebase, run the control experiment — it takes two minutes and gives a
definitive answer:

```
git switch --detach upstream/main
git checkout <sync-branch> -- .github/workflows/t3x-ci.yml
git switch -c t3x/ci-control-upstream && git commit -am "ci: control run" && git push -u origin HEAD
gh workflow run t3x-ci.yml -R radroid/t3code --ref t3x/ci-control-upstream
```

That branch is pristine upstream plus one fork-owned file. If it fails the same way, the failure is
upstream-inherited and no fork patch caused it. Delete the branch afterwards.

Fix such failures in `.github/workflows/t3x-ci.yml` (fork-owned) rather than by patching the upstream
file — patching adds a row to `docs/coil/SEAMS.md` and permanent rebase cost for a CI-environment
problem. The `--testTimeout` override on the Test step exists for exactly this reason; its comment
records the case.

## What the agent does (and what a human doing it locally should do)

This is the checklist the workflow prompt mirrors — follow it if you resolve locally instead.

1. `git fetch upstream && git switch -c t3x/sync-<id> main`
2. `git rebase upstream/main`. Resolve each conflict by understanding intent — favour
   upstream's structure while preserving the fork's t3x behaviour. `git add -A && git rebase --continue`.
   `rerere` auto-applies anything resolved before, but **only in a local clone** (`setup-fork.sh`
   enables it) — the CI resolver gets no rerere replay.
3. **Do the thing CI cannot:** review the upstream commits that touched t3x _seams_
   (`docs/coil/SEAMS.md`) even when they did **not** textually conflict — upstream may have
   changed the semantics of an API the fork hooks into. For each seam file,
   `git log <old>..upstream/main -- <file>` and read the diffs; confirm the fork's feature
   still behaves.
4. **Parallel path:** `apps/coil-home/` duplicates `apps/marketing/`. A copy cannot conflict, so
   the rebase will never flag it — it just drifts. Check upstream's marketing churn this cycle
   (`git log <merge-base>..upstream/main --oneline -- apps/marketing`) and either port
   intentionally or record "nothing worth porting".
5. If a patch commit went **empty/dropped**, upstream absorbed it — confirm the behaviour now
   exists upstream, drop the patch, and note it.
6. Verify: `vp run typecheck && vp run lint && vp run test --testTimeout=120000`. Fix the fork's
   patches to match upstream's new internals until green.

   Two notes. **`AGENTS.md` says "do not run repo-wide checks" — an upstream sync is the sanctioned
   exception.** A rebase can break any package, so the full suite is the point; that rule is about
   routine feature work. And the `--testTimeout` flag is required (see the section above); it must
   not follow a `--` separator or it is silently ignored.

7. **When green:** push the branch and open a PR into `main` (`gh pr create`). A human reviews
   and **lands it — see [Landing a sync PR](#landing-a-sync-pr-do-not-use-the-github-merge-button);
   the GitHub merge button does not work on a rebased branch.** The recovery tag
   `t3x/last-good-*` from the Action is the rollback point.
8. **If genuinely blocked** (e.g. upstream refactored the orchestration engine in a way that
   breaks auto-resume's detection): do NOT open a green PR. Push the branch, open a **draft**
   PR, and comment on the issue with exactly what is blocked and what decision is needed.

## Landing a sync PR (do NOT use the GitHub merge button)

The resolver's branch is the fork's patch series **rebased onto new upstream**, so `main` is
_not_ an ancestor of it. GitHub reports the PR `CONFLICTING`/`DIRTY` (a huge diff plus add/add
conflicts on the fork's own files), and **Merge / Squash / Rebase all fail** — the branch is
meant to _replace_ `main`'s history, not extend it. Land it by force-updating `main` to the
reviewed tip instead.

The branch is `t3x/sync-<workflow run id>` — the run id, not the issue number. A **draft** PR means
the resolver could not get all three verify steps green; read its issue comment before anything else.

**1. Get a CI signal — it may not appear on its own.** `t3x-ci.yml` has a `push` trigger on
`t3x/sync-**`, but it only fires if the resolver pushed with a PAT (`T3X_SYNC_TOKEN`). On the
`GITHUB_TOKEN` fallback GitHub creates no workflow runs from its own events, so neither that
trigger nor `pull_request` fires. Check first; if there is no run, dispatch it:

```
gh workflow run t3x-ci.yml -R radroid/t3code --ref t3x/sync-<id>
gh run list -R radroid/t3code --workflow t3x-ci.yml --branch t3x/sync-<id>
```

**2. Review what the resolver changed in each fork patch.** A plain `git diff` against `main` is a
useless whole-upstream delta; use `range-diff`:

```
git fetch origin && git fetch upstream
OLD=$(git merge-base origin/main upstream/main)
NEW=$(git merge-base origin/t3x/sync-<id> upstream/main)
git range-diff "$OLD..origin/main" "$NEW..origin/t3x/sync-<id>"
```

Confirm no fork patch silently vanished — `git rev-list --count --no-merges upstream/main..origin/t3x/sync-<id>`
should equal the pre-sync patch count.

**3. Land it.** Save the old `main` first; step 5 needs it.

```
git fetch origin
OLD_MAIN=$(git rev-parse origin/main)          # SAVE THIS
git push --force-with-lease origin origin/t3x/sync-<id>:main
```

`--force-with-lease` leases against your local `refs/remotes/origin/main`, so the `git fetch`
immediately before is required. It works from any worktree with no branch checked out.

**4. Close out.** GitHub usually auto-marks the PR `MERGED` on force-update, in which case
`gh pr close` errors — check first. The **issue** is what actually needs closing by hand.

```
gh pr view <n> -R radroid/t3code --json state
gh issue close <sync-issue> -R radroid/t3code --comment "Landed by force-updating main"
```

**5. Rebase in-flight branches with `--onto`, not a plain rebase.** `main`'s history was _replaced_,
so `git rebase origin/main` would try to replay all of pre-sync `main`:

```
git rebase --onto origin/main "$OLD_MAIN" t3x/<feature>
git push --force-with-lease origin t3x/<feature>
```

Any branch left un-rebased shows `[origin/main: ahead N, behind M]` and cannot land.

- `main` has **no branch protection** (verified: no protection, no rulesets), so the force-push is
  allowed but unguarded. Rollback is the `t3x/last-good-*` tag from the escalation issue:
  `git push --force-with-lease origin t3x/last-good-<stamp>^{commit}:main`. The tag is cut per daily
  run on pre-rebase `main`, so if feature PRs merged after it, rolling back drops them. If the tag
  push failed the issue says `none` and there is no rollback point.
- Repair local checkouts: `git fetch origin && git branch -f main origin/main` (a plain
  `git checkout main` fails if another worktree holds it). The auto-build worktree needs no action —
  it force-detaches to the freshly fetched sha on every tick.
- To re-gate locally before landing:
  `git switch --detach origin/t3x/sync-<id> && vp run typecheck && vp run lint && vp run test`.

## One-time setup

1. Install the **Claude GitHub App**: run `/install-github-app` in Claude Code (repo admin
   required). It adds the auth secret (`CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY`).
2. When the installer offers to add the **generic `@claude` responder** workflow, choose
   **Skip** — this repo ships its own `t3x-sync-resolve.yml`, and a generic responder would
   double-fire on the same `@claude resolve` comment.
3. Add the repo secret **`T3X_SYNC_TOKEN`**. Without it both sync workflows push as
   `GITHUB_TOKEN` and cannot land any upstream range that touches `.github/workflows/**`
   (see [A `push-failed` issue is not a conflict](#a-push-failed-issue-is-not-a-conflict--do-not-send-the-agent)).

   Prefer a **fine-grained PAT scoped to `radroid/t3code` only**, with repository permissions
   _Contents: read & write_ and _Workflows: read & write_ — the resolver hands this credential to
   an LLM-driven job, so a classic `repo` + `workflow` PAT (valid across every repo the account
   can reach) is a much wider blast radius for the same capability. A GitHub App installation
   token with Workflows: write works too.

   ```
   gh secret set T3X_SYNC_TOKEN -R radroid/t3code
   ```

   Fine-grained PATs expire; when one does, the daily job escalates as `push-failed` rather than
   failing silently. Note that pushes made with a PAT are authored by **you**, not
   `github-actions[bot]`, so they do trigger workflows — `t3x-ci.yml` will start firing on
   resolver branches by itself, and pushes to `main` will run the fork's CI.

Only a user with write access (`OWNER`/`MEMBER`/`COLLABORATOR`) can trigger the resolver, so the
API budget can't be spent by a passer-by on the public fork.

## Force a sync outside the daily schedule

```
gh workflow run "t3x upstream sync (daily)" -R radroid/t3code -f dry_run=true
```

(drop `dry_run` to actually push a clean rebase).
