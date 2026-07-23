# t3x daily sync — Claude scheduled-agent runbook

This is the prompt/checklist for the **daily Claude Code scheduled agent** that backs
the GitHub Action. The Action does the mechanical rebase every day for free; this agent
only does real work when the Action escalates. See the design spec
`docs/superpowers/specs/2026-07-23-fork-upstream-sync-design.md` (A6).

## How to schedule it (Claude app)

Create a daily routine that runs in the fork's working copy (or a fresh clone of
`radroid/t3code`) with the prompt below. Schedule it shortly **after** the Action's
08:00 UTC run (e.g. 08:30 UTC) so an escalation issue already exists if there is one.

## The prompt to schedule

> You are the daily upstream-sync agent for the `radroid/t3code` fork.
>
> 1. Run: `gh issue list --label t3x-sync --state open --json number,title,body`
> 2. **If there are no open `t3x-sync` issues:** the automated rebase succeeded (or had
>    nothing to do). Reply "clean — nothing to do" and stop. Do not spend further effort.
> 3. **If there is an open issue**, read its status JSON, then in the working copy:
>    - `git fetch upstream && git checkout main`
>    - `git rebase upstream/main`
>    - **Conflict case:** resolve each conflict. `rerere` will auto-apply anything seen
>      before; resolve the rest by understanding intent, favouring upstream's structure
>      while preserving the fork's behavior. `git add -A && git rebase --continue`.
>    - **Verify failed case:** reproduce with `vp run typecheck && vp run lint && vp run test`
>      and fix the fork's patches to match upstream's new internals.
> 4. **Always do the thing CI cannot:** review the upstream commits that touched t3x
>    *seams* (see `docs/t3x/SEAMS.md`) even when they did **not** textually conflict —
>    upstream may have changed the semantics of an API the fork hooks into. For each
>    seam file, `git log <old>..upstream/main -- <file>` and read the diffs. Confirm the
>    fork's feature still behaves correctly against the new code.
> 5. If a patch commit went **empty/dropped** during rebase, that means upstream absorbed
>    it. Confirm the behavior now exists upstream, drop the patch, and note it in the issue.
> 6. When green: `git push --force-with-lease origin main`, then
>    `gh issue close <n> --comment "resynced: <one-line summary of what changed>"`.
> 7. If you genuinely cannot resolve it (e.g. upstream refactored the orchestration
>    engine in a way that breaks auto-resume's detection), do NOT push. Comment on the
>    issue with exactly what is blocked and what decision is needed, and stop.
>
> Never force-push if verification is red. The recovery tag `t3x/last-good-*` from the
> Action is your rollback point.

## Manual trigger

To force a sync outside the schedule:
`gh workflow run "t3x upstream sync (daily)" -R radroid/t3code -f dry_run=true`
(drop `dry_run` to actually push).
