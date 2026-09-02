# t3x daily sync — conflict-resolver runbook

The daily GitHub Action (`coil-upstream-sync.yml`) **merges** `upstream/main` into fork `main`
every day for free. When it **can't** complete — a merge conflict or a red verify — it opens (or
updates) a single `coil-sync` issue with a status JSON block. This runbook is how that issue gets
resolved: **on demand, by activating an agent**. This resolver runs only when asked — though
`coil-ci.yml` still gates every push and PR, and `coil-weekly-verify.yml` runs on Sundays.

The sync merges; it does not rebase (changed 2026-09-02). `main` only ever fast-forwards, so
nothing in this process force-pushes, no worktree or tag or open PR goes stale on a sync day, and a
sync PR is an ordinary PR you land with the merge button. The one rule that replaces all of that
machinery: **land a sync PR as a merge commit, never a squash.**

See the design specs `docs/superpowers/specs/2026-07-23-fork-upstream-sync-design.md` (the
daily/weekly sync + the `coil-sync` escalation contract) and
`docs/superpowers/specs/2026-07-25-sync-conflict-agent-design.md` (this resolver).

## Activate the agent (the one action)

On the open `coil-sync` issue, comment:

```
@claude resolve
```

That triggers `.github/workflows/coil-sync-resolve.yml`, which runs Claude Code in CI to replay
the merge, resolve the conflicts, run verify, and **open a PR into `main`**. It never pushes to
`main` — you review it and land it yourself (see [Landing a sync PR](#landing-a-sync-pr-merge-commit-never-squash)).
The agent comments the PR link back on the issue when done.

> **The comment path always uses `claude-sonnet-5`.** The `model` input only exists on manual
> dispatch, so `@claude resolve` cannot select a stronger model. For anything but a small range,
> dispatch it instead:
>
> ```
> gh workflow run "coil sync resolve (agent)" -R radroid/t3code -f issue=<n> -f model=claude-opus-5
> ```

**Check the budget before you pick a path.** The job is capped at `timeout-minutes: 45` and
`--max-turns 150`. The one successful resolve to date absorbed a 36-commit upstream range against
37 fork commits and used 36m15s — 81% of the budget. A materially larger range will exhaust it, and
a timeout mid-merge leaves an unpushed branch and a spent budget. Raising the caps needs a workflow
edit; `workflow_dispatch` reads the workflow file from `--ref`, so you can carry raised limits on a
scratch branch without merging it (the job still checks out `main` and merges upstream into it):

```
gh workflow run coil-sync-resolve.yml -R radroid/t3code \
  --ref t3x/bigger-resolve-budget -f issue=<n> -f model=claude-opus-5
```

Measure the range first:

```
git fetch upstream
git rev-list --count $(git merge-base main upstream/main)..upstream/main   # upstream commits to absorb
git rev-list --count --no-merges upstream/main..main                       # fork commits (a merge moves none of them)
```

### The daily job cannot trigger the resolver

Its escalation comment contains the literal `@claude resolve` string, but GitHub creates no workflow
run from a `GITHUB_TOKEN`-authored event, and `github-actions[bot]` reports `author_association:
NONE`, which fails the workflow's own permission check. Resolution is always human-initiated. Do not
"fix" the phrasing in the escalation body — it is the copy-pasteable instruction for the human.

A comment that fails the gate (missing `coil-sync` label, wrong author, edited rather than newly
created) shows up in the Actions tab as **skipped**, not as an error. Check there if nothing happens.

### Not every `coil-sync` issue is a merge conflict

`coil-weekly-verify.yml` escalates onto the _same_ label and issue with `**kind:** weekly-build`.
`@claude resolve` passes the full gate on those too and will spend an entire agent budget replaying
a merge that is not the problem. Read the `**Result:**` / `**kind:**` line first; a `weekly-build`
failure means fix the build.

### A `push-failed` issue is not a conflict — do not send the agent

`**Result:** push-failed` means the merge was clean and typecheck/lint/test were all green, and
then the fast-forward `git push origin main` was rejected. Replaying the merge fixes nothing.

**Read the push output in the issue before doing anything.** If it says `fetch first` /
non-fast-forward, `main` simply moved while the job ran — a PR landed — and nothing is wrong:
re-running _coil upstream sync (daily)_ is the entire fix. Anything else is a credential or
branch-protection problem; fix that, then re-run. In neither case send the resolver agent.

The dominant cause: **GitHub forbids `GITHUB_TOKEN` from creating or updating any file under
the `.github/workflows/` directory** — on `main` or on a branch. It is not grantable from the
workflow's `permissions:` block (there is no `workflows` key), so the only fix is pushing as
something else. Both sync workflows therefore check out with `secrets.T3X_SYNC_TOKEN` (see
[One-time setup](#one-time-setup)), falling back to `GITHUB_TOKEN` when it is unset.

This stayed invisible until 2026-08-11, when the absorbed range first included an upstream commit
that edited a workflow file (`1b120f352`, _fix(ci): extend release publish timeout_). Every sync
carrying an upstream CI change hits it. Nothing lands when it happens: `origin/main` is untouched
and in-flight PRs stay mergeable, which is why re-running is safe.

### When verify goes red on code the fork does not own

A sync can import an upstream test that fails **in this fork's CI but not upstream's**, because
upstream runs on `blacksmith-*` runners and the fork runs on 2-core `ubuntu-latest`. Before treating
a red verify as a bad merge, run the control experiment — it takes two minutes and gives a
definitive answer:

```
git switch --detach upstream/main
git checkout <sync-branch> -- .github/workflows/coil-ci.yml
git switch -c t3x/ci-control-upstream && git commit -am "ci: control run" && git push -u origin HEAD
gh workflow run coil-ci.yml -R radroid/t3code --ref t3x/ci-control-upstream
```

That branch is pristine upstream plus one fork-owned file. If it fails the same way, the failure is
upstream-inherited and nothing the fork did caused it. Delete the branch afterwards.

Fix such failures in `.github/workflows/coil-ci.yml` (fork-owned) rather than by patching the upstream
file — patching adds a row to `docs/coil/SEAMS.md` and permanent sync cost for a CI-environment
problem. The `--testTimeout` override on the Test step exists for exactly this reason; its comment
records the case.

## What the agent does (and what a human doing it locally should do)

This is the checklist the workflow prompt mirrors — follow it if you resolve locally instead.

1. `git fetch upstream && git switch -c coil/sync-<id> main`
2. `git merge upstream/main`. Resolve each conflict by understanding intent — favour
   upstream's structure while preserving the fork's coil behaviour. `git add <file>` per
   resolution, then `git commit` to close the merge — **one** merge commit, not a rebase and
   not a flattened squash. `rerere` auto-applies anything resolved before, but **only in a
   local clone** (`setup-fork.sh` enables it) — the CI resolver gets no rerere replay.
3. **Do the thing CI cannot:** review the upstream commits that touched t3x _seams_
   (`docs/coil/SEAMS.md`) even when they did **not** textually conflict — upstream may have
   changed the semantics of an API the fork hooks into. For each seam file,
   `git log <old>..upstream/main -- <file>` and read the diffs; confirm the fork's feature
   still behaves.
4. **Parallel path:** `apps/coil-home/` duplicates `apps/marketing/`. A copy cannot conflict, so
   the merge will never flag it — it just drifts. Check upstream's marketing churn this cycle
   (`git log <merge-base>..upstream/main --oneline -- apps/marketing`) and either port
   intentionally or record "nothing worth porting".
5. **Absorbed work is now yours to remove.** A merge never drops a fork commit, so when upstream
   has grown its own version of something the fork carries, both survive. Confirm the behaviour
   really exists upstream, delete the fork's redundant copy as its own commit on the branch, and
   note it in the PR. (The old rebase-era "dropped patch" escalation is gone; nothing can vanish
   on its own any more.)
6. Verify: `vp run typecheck && vp run lint && vp run test --testTimeout=120000`. Fix the fork's
   code to match upstream's new internals until green.

   Two notes. **`AGENTS.md` says "do not run repo-wide checks" — an upstream sync is the sanctioned
   exception.** A sync can break any package, so the full suite is the point; that rule is about
   routine feature work. And the `--testTimeout` flag is required (see the section above); it must
   not follow a `--` separator or it is silently ignored.

7. **When green:** push the branch and open a PR into `main` (`gh pr create`). A human reviews
   and **lands it with a merge commit — see
   [Landing a sync PR](#landing-a-sync-pr-merge-commit-never-squash).** To undo a landed sync,
   `git revert -m 1 <merge sha>` — but that leaves the merge in `main`'s ancestry, so the sync will
   never re-offer the range (see the rollback note there). The `coil/last-good-*` tag from the
   Action names the exact pre-sync tip if you need the tree itself.
8. **If genuinely blocked** (e.g. upstream refactored the orchestration engine in a way that
   breaks auto-resume's detection): do NOT open a green PR. Push the branch, open a **draft**
   PR, and comment on the issue with exactly what is blocked and what decision is needed.

## Landing a sync PR (merge commit, never squash)

The resolver's branch is `main` **plus one merge commit**, optionally followed by ordinary commits
(absorbed-work removals, verify fix-ups); `main` is an ancestor either way. GitHub can build the
merge ref, `pull_request` fires, the diff is honest, and the merge button works. Land it with a
**merge commit**, and set the subject:

```
gh pr merge <n> -R radroid/t3code --merge \
  --subject "chore(coil): merge upstream/main <sha> (N commits)"
```

`--subject` is not decoration. GitHub's default merge title is `Merge pull request #N from …`, and
the release changelog walks `--first-parent`, so that default is what users would read as the entry
for a whole upstream range. The daily job writes the `chore(coil):` subject itself; a PR landed by
hand carries it only because you passed it.

**Never `--squash`, never `--rebase`.** A squash rewrites the whole sync into one fork commit whose
only parent is the old `main`. Upstream's commits stop being reachable from `main`, so the merge-base
with `upstream/main` never advances: the next daily sync re-offers the same range, re-conflicts on
the same files, and does it again every day after that. It also invalidates `docs/coil/SEAMS.md`,
which is measured against that merge-base. The merge commit is the whole point of the design — it is
what records that this range is absorbed.

The branch is `coil/sync-<workflow run id>` — the run id, not the issue number. A **draft** PR means
the resolver could not get all three verify steps green; read its issue comment before anything else.

**1. Get a CI signal — it may not appear on its own.** `coil-ci.yml` has a `push` trigger on
`coil/sync-**` and a `pull_request` trigger, but GitHub creates no workflow run from an event its own
`GITHUB_TOKEN` authored. If the resolver pushed and opened the PR on the token fallback rather than
`T3X_SYNC_TOKEN`, neither trigger fires. Check first; if there is no run, dispatch it:

```
gh workflow run coil-ci.yml -R radroid/t3code --ref coil/sync-<id>
gh run list -R radroid/t3code --workflow coil-ci.yml --branch coil/sync-<id>
```

**2. Review the resolutions, not the range.** The PR diff is upstream's entire range; reading it is
not the job. Two views do the actual work:

```
git fetch origin && git fetch upstream
B=origin/coil/sync-<id>                       # the branch tip
M=$(git rev-list --merges -1 "$B")            # the merge commit — NOT necessarily the tip

git log --merges -1 -p --cc "$M"              # the combined diff: ONLY hunks that differ from BOTH
                                              # parents — i.e. exactly the conflict resolutions
git diff "$M^1" "$B" --stat                   # what main gains: upstream's range, those
                                              # resolutions, and any follow-up commits
```

`--cc` is the review surface. A merge that resolved nothing by hand shows an empty combined diff; every
hunk it does print is a decision someone made, and each one deserves a reason. (`git diff "$M^2" "$M"`
is the mirror image — the fork's whole footprint against upstream, which is what the seam ledger
measures.)

Then do the thing no diff shows — the **seam review**. Upstream can change the semantics of an API the
fork hooks into without ever touching a line the fork also touched, so there is no conflict to see:

```
OLD_MB=$(git merge-base "$M^1" "$M^2")        # the merge-base this sync advances from
git log "$OLD_MB..upstream/main" -- <seam file from docs/coil/SEAMS.md>
```

There is no dropped-patch check any more. A merge replays nothing, so no fork commit can go missing;
`git rev-list --count --no-merges upstream/main..$B` only moves if someone deliberately removed
absorbed work, which the PR body should say.

**3. Close out.** The PR closes itself as `MERGED`. The **issue** still needs closing by hand.

```
gh issue close <sync-issue> -R radroid/t3code --comment "Landed as a merge commit"
```

**4. Nothing else needs repairing.** `main` only moved forward, so worktrees take the change with
`git pull --ff-only`, in-flight branches pick it up with an ordinary `git merge origin/main` or
`git rebase origin/main`, and every tag, open PR and local branch stays valid. This is the step that
used to be the expensive one.

- **To undo a landed sync:** `git revert -m 1 <merge sha>` on a branch, then a normal PR — an ordinary
  commit, no force-push, and history stays intact. `-m 1` keeps the fork's side. **Know the
  consequence:** the merge itself stays in `main`'s ancestry, so the daily sync sees that range as
  already absorbed, reports no-op (exit 10), and never re-offers it — and every later sync lands on
  top of the reverted tree. Re-absorbing the range means reverting the revert on a branch, not
  waiting for the sync to bring it back. The `coil/last-good-*` tag the daily job cuts still names
  the exact pre-sync tip if you want to diff against it or reset to it; if its push failed, the
  issue says `none`.
- To re-gate locally before landing:
  `git switch --detach origin/coil/sync-<id> && vp run typecheck && vp run lint && vp run test`.

## One-time setup

1. Install the **Claude GitHub App**: run `/install-github-app` in Claude Code (repo admin
   required). It adds the auth secret (`CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY`).
2. When the installer offers to add the **generic `@claude` responder** workflow, choose
   **Skip** — this repo ships its own `coil-sync-resolve.yml`, and a generic responder would
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
   `github-actions[bot]`, so they do trigger workflows — `coil-ci.yml` will start firing on
   resolver branches by itself, and pushes to `main` will run the fork's CI.

Only a user with write access (`OWNER`/`MEMBER`/`COLLABORATOR`) can trigger the resolver, so the
API budget can't be spent by a passer-by on the public fork.

## Force a sync outside the daily schedule

```
gh workflow run "coil upstream sync (daily)" -R radroid/t3code -f dry_run=true
```

(drop `dry_run` to actually fast-forward `main` when the merge is clean and verify is green).
