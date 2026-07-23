# Fork Hygiene & Daily Upstream Sync — Design

**Date:** 2026-07-23
**Status:** Approved (brainstorming)
**Fork:** `radroid/t3code` (fork of `pingdotgg/t3code`, MIT-licensed)
**Companion spec:** `2026-07-23-usage-limit-auto-resume-design.md` (Project B)

## Problem

The fork will accumulate local features (starting with usage-limit auto-resume).
Upstream ships ~7 commits/day (612 in the last 60 days). Without discipline, drift
compounds and every sync becomes archaeology. Two failure modes to prevent:

1. **Compounding conflict surface** — if each new feature edits hot upstream files,
   the daily sync gets worse forever. `apps/server/src/server.ts` alone changed 25
   times in 60 days.
2. **Unattended-toil** — the user is often away; a sync process that always needs a
   human defeats the purpose.

## Goals

- A daily, mostly-hands-off upstream sync that costs **zero Claude tokens on clean days**.
- A structure where **conflict surface is bounded by the number of upstream files
  touched, not the number of features built**.
- Every local change stays a clean, reviewable, upstreamable commit.
- A weekly deep verification (full build) that never blocks the daily rebase.

## Non-goals

- Accepting upstream PRs (upstream isn't taking contributions yet — fork is the only route).
- Any change to how the app itself is built or released.

---

## A1. Remote & branch layout

Current remotes are inverted and dangerous: `origin` points at **upstream**
(`pingdotgg`) for both fetch AND push, and `main` tracks `origin/main`. A reflexive
`git push` aims at upstream (rejected by perms, but wrong intent), and `git pull`
pulls upstream into the build branch silently.

Target layout:

```
upstream  https://github.com/pingdotgg/t3code.git   (fetch)
upstream  DISABLE_PUSH                                (push explicitly disabled)
origin    https://github.com/radroid/t3code.git      (fetch + push)   ← the fork
```

- `main` = `upstream/main` + a small **patch series** on top, tracking `origin/main`.
  This is the build branch and the thing the user runs.
- Feature work happens on `t3x/<feature>` branches cut from `main`, then collapses to
  **one commit per feature** with a `t3x:` subject prefix.
- Result: `git log --oneline upstream/main..main` **is** the patch manifest, and
  `git format-patch upstream/main` **is** an upstream PR set whenever desired.
- Local git config: `rerere.enabled=true`, `rerere.autoupdate=true` so a conflict
  resolved once replays automatically on future rebases.

> **rerere scope (corrected after review):** `.git/rr-cache` is untracked and never
> pushed, and the daily CI job only _aborts_ on conflict (it never resolves), so it
> neither produces nor can consume shared resolutions. rerere therefore lives **purely
> locally**, where the sync agent (A6) actually resolves conflicts — that is exactly
> where the replay value is. The CI job does not attempt to cache or share `rr-cache`.

> **Direct-commit discipline (corrected after review):** the daily force-push assumes
> `main` only ever advances via the sync job or a fast-forward of merged `t3x/*`
> branches. A local commit made _directly_ on `main` (not via a feature branch) would be
> clobbered on the next green sync. Always branch; never commit straight to `main`.

## A2. Conflict-surface budget (the core discipline)

**Rule: your conflict surface is the set of upstream files you edit, and it is
capped, not per-feature.**

```
apps/server/src/t3x/          ← you own it; upstream never touches it
  index.ts                    ← T3xLayerLive = Layer.mergeAll(autoResume, feature2, …, featureN)
  autoResume/…                ← Project B lives here
apps/web/src/t3x/             ← same, for any future UI
docs/t3x/SEAMS.md             ← authoritative list of every upstream line touched
```

- Every new feature registers itself **inside `t3x/index.ts`** (a file upstream never
  edits) — never by adding another edit to a hot upstream file.
- `apps/server/src/server.ts` gets **one** import and **one** `Layer.provideMerge`,
  once, forever.
- `SEAMS.md` makes the seam set auditable. If it grows past a handful of lines, that's
  the signal to re-isolate, not to accept more daily pain.

## A3. Inherited-workflow neutralization

The fork inherited all 9 upstream GitHub workflows, all `active`, including
schedule-triggered `Release` and two `Mobile EAS` jobs that fail for want of secrets.
Left alone they burn Actions minutes and email failures on every push.

- Disable all inherited workflows on the fork via `gh workflow disable` (reversible
  with `gh workflow enable`). This is a fork-account setting, not a code change, so it
  never conflicts and never rebases away.
- The two new t3x workflows (A4, A5) are the only ones that should run on the fork.

## A4. Daily sync job — `.github/workflows/t3x-upstream-sync.yml`

New file in an upstream-owned directory → conflicts with nothing. Triggers: daily
`schedule` + `workflow_dispatch` (with a `dry_run` input).

1. Checkout `origin/main`, full history.
2. Fetch `upstream`. If `upstream/main` hasn't moved → exit no-op.
3. Tag `t3x/last-good-<date>` and push the tag — pre-rebase state recoverable. The tag is
   advertised in the escalation issue **only if its push to origin actually succeeded** (a
   local-only tag on an ephemeral CI runner is unrecoverable, so it is never surfaced).
4. `git rebase upstream/main`. On conflict: `--abort`, record conflicted paths and the
   upstream commits that touched them.
5. **Verify (daily depth):** `pnpm install --frozen-lockfile`, then `typecheck` +
   `lint` + server tests. (Full build is weekly — A5.)
6. Outcome (driven by `scripts/t3x/sync-upstream.sh` exit codes; the push step fires
   **only** on exit 0):
   - **0 — green** → `git push --force-with-lease` to `origin/main`. Done, zero tokens.
   - **10 — no-op** → upstream unchanged; nothing to do.
   - **20 — conflict** / **30 — red verify** → push nothing. Open (or update) a single
     issue labelled `t3x-sync` with a JSON status block: `kind: "daily"`, conflicted files,
     failing command, upstream commit range, current patch manifest.
   - **40 — dropped patch** → push nothing; escalate (see step 7).
7. **Dropped-patch detector:** if one of the fork's own patch commits vanishes during
   rebase (upstream likely absorbed an equivalent change), the script exits **40** even
   when verification is green. This blocks the auto-push and opens the `t3x-sync` issue so
   a human/agent confirms the loss was intentional before the fork permanently drops the
   change — it never vanishes silently. The count is taken over **non-merge commits**
   (`git rev-list --count --no-merges`): a default rebase flattens merge commits, so
   counting them would false-positive whenever fork `main` contains a merge (e.g. a t3x PR
   merged via GitHub's button), stalling the sync every day; non-merge counting is
   invariant across that flattening while still catching a genuinely absorbed patch.

> Force-push is safe here: `main` is `upstream/main` + a rebased patch series, and the
> pre-rebase tag from step 3 plus `--force-with-lease` guard against clobbering.

## A5. Weekly deep-verify job — `.github/workflows/t3x-weekly-verify.yml`

Weekly `schedule` + `workflow_dispatch`. Runs the **full monorepo build** against the
current `origin/main`. Does **not** rebase and **never blocks the daily job**. On
failure, opens/updates the same `t3x-sync` issue with `kind: "weekly-build"`. This
catches semantic build regressions that a green typecheck/lint/test pass misses,
without slowing the daily loop.

## A6. Escalation contract

The Action and the user's scheduled Claude agent talk through exactly one channel: an
open GitHub issue labelled `t3x-sync`, discriminated by a `kind` field
(`daily` | `weekly-build`).

- The daily Claude routine starts with `gh issue list -l t3x-sync --state open`.
  - **Empty** → exits in seconds, near-zero tokens. (This is why the model is hybrid.)
  - **Non-empty** → replays the rebase locally, resolves conflicts, AND does what CI
    structurally cannot: reviews the upstream commits that touched t3x **seams**
    without textually conflicting — the silent-semantic-drift case a green rebase
    hides. Then pushes and closes the issue.
- The Claude routine is set up by the user in the Claude app on a daily schedule; this
  spec provides the exact prompt/checklist it should run (delivered as
  `docs/t3x/sync-agent-runbook.md`).

## A7. Setup script — `scripts/t3x/setup-fork.sh`

Idempotent, reversible, documents every action. Performs A1 (remotes + rerere) and
prints the `gh` commands for A3 (or runs them behind a `--disable-workflows` flag).
Safe to re-run; detects already-applied state.

---

## Deliverables

| Artifact               | Path                                      | Upstream conflict risk |
| ---------------------- | ----------------------------------------- | ---------------------- |
| Remote/rerere setup    | `scripts/t3x/setup-fork.sh`               | none (new file)        |
| Daily sync workflow    | `.github/workflows/t3x-upstream-sync.yml` | none (new file)        |
| Weekly verify workflow | `.github/workflows/t3x-weekly-verify.yml` | none (new file)        |
| Seam ledger            | `docs/t3x/SEAMS.md`                       | none (new file)        |
| Sync-agent runbook     | `docs/t3x/sync-agent-runbook.md`          | none (new file)        |

**Total edits to upstream-owned files: zero.** (Project B adds the only 2-line seam.)

## Verification depth summary

- **Daily:** `typecheck` + `lint` + server tests (fast, gates the push).
- **Weekly:** full `pnpm build` across the monorepo (slow, advisory, non-blocking).

## Rollback

- Remotes/rerere: re-run setup script notes, or `git remote rename` back.
- Workflows: `gh workflow enable <id>`.
- A bad sync: `git reset --hard t3x/last-good-<date>` (tag pushed pre-rebase).
