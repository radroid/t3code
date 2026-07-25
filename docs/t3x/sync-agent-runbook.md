# t3x daily sync — conflict-resolver runbook

The daily GitHub Action (`t3x-upstream-sync.yml`) does the mechanical rebase every day for
free. When it **can't** complete — a merge conflict, a red verify, or a dropped patch — it
opens (or updates) a single `t3x-sync` issue with a status JSON block. This runbook is how that
issue gets resolved: **on demand, by activating an agent**. Nothing runs on clean days.

See the design specs `2026-07-23-fork-upstream-sync-design.md` (the daily/weekly sync + the
`t3x-sync` escalation contract) and `2026-07-25-sync-conflict-agent-design.md` (this resolver).

## Activate the agent (the one action)

On the open `t3x-sync` issue, comment:

```
@claude resolve
```

That triggers `.github/workflows/t3x-sync-resolve.yml`, which runs Claude Code in CI to replay
the rebase, resolve the conflicts, run verify, and **open a PR into `main`**. It never pushes to
`main` — you review and merge the PR. The agent comments the PR link back on the issue when done.

Prefer a button? Run it manually instead (optionally pass the issue number and bump the model
for a gnarly merge):

```
gh workflow run "t3x sync resolve (agent)" -R radroid/t3code -f issue=<n> -f model=claude-opus-5
```

## What the agent does (and what a human doing it locally should do)

This is the checklist the workflow prompt mirrors — follow it if you resolve locally instead.

1. `git fetch upstream && git switch -c t3x/sync-<id> main`
2. `git rebase upstream/main`. Resolve each conflict by understanding intent — favour
   upstream's structure while preserving the fork's t3x behaviour. `rerere` (enabled locally)
   auto-applies anything resolved before. `git add -A && git rebase --continue`.
3. **Do the thing CI cannot:** review the upstream commits that touched t3x *seams*
   (`docs/t3x/SEAMS.md`) even when they did **not** textually conflict — upstream may have
   changed the semantics of an API the fork hooks into. For each seam file,
   `git log <old>..upstream/main -- <file>` and read the diffs; confirm the fork's feature
   still behaves.
4. If a patch commit went **empty/dropped**, upstream absorbed it — confirm the behaviour now
   exists upstream, drop the patch, and note it.
5. Verify: `vp run typecheck && vp run lint && vp run test`. Fix the fork's patches to match
   upstream's new internals until green.
6. **When green:** push the branch and open a PR into `main` (`gh pr create`). A human merges.
   The recovery tag `t3x/last-good-*` from the Action is the rollback point.
7. **If genuinely blocked** (e.g. upstream refactored the orchestration engine in a way that
   breaks auto-resume's detection): do NOT open a green PR. Push the branch, open a **draft**
   PR, and comment on the issue with exactly what is blocked and what decision is needed.

## One-time setup

1. Install the **Claude GitHub App**: run `/install-github-app` in Claude Code (repo admin
   required). It adds the auth secret (`CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY`).
2. When the installer offers to add the **generic `@claude` responder** workflow, choose
   **Skip** — this repo ships its own `t3x-sync-resolve.yml`, and a generic responder would
   double-fire on the same `@claude resolve` comment.

Only a user with write access (`OWNER`/`MEMBER`/`COLLABORATOR`) can trigger the resolver, so the
API budget can't be spent by a passer-by on the public fork.

## Force a sync outside the daily schedule

```
gh workflow run "t3x upstream sync (daily)" -R radroid/t3code -f dry_run=true
```

(drop `dry_run` to actually push a clean rebase).
