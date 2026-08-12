# On-demand Sync-Conflict Resolver Agent — Design

**Date:** 2026-07-25
**Status:** Approved (brainstorming)
**Fork:** `radroid/t3code`
**Builds on:** `2026-07-23-fork-upstream-sync-design.md` (the daily/weekly sync + `coil-sync` escalation contract)

## Problem

The daily upstream sync (`coil-upstream-sync.yml`) rebases the fork onto `pingdotgg/t3code`
and, when it hits a conflict / red verify / dropped patch, is supposed to open a `coil-sync`
issue that an agent picks up. Two gaps surfaced in production:

1. **The escalation never actually fired.** `gh issue create --label coil-sync` aborts the
   whole creation when the label lookup lags behind the preceding `gh label create` (GitHub
   API replication race) or the label is absent. Both scheduled runs (2026-07-24 verify-fail,
   2026-07-25 conflict in `docs/coil/SEAMS.md`) went red with **no issue ever created**, so the
   handoff channel was silent. *(Fixed separately — see the escalation-resilience commit.)*
2. **The handoff model is a scheduled poller, not on-demand.** `docs/coil/sync-agent-runbook.md`
   assumed a **daily Claude scheduled routine** the user wires up in the Claude app, which runs
   every day and mostly no-ops. The user wants the opposite: do nothing until a conflict
   happens, then **activate an agent with one action** to get a fix.

## Goal

When the daily sync escalates, the user fixes a complicated merge by a **single action** —
commenting `@claude resolve` on the auto-created issue (or clicking *Run workflow*) — and gets
back a **PR to review**. No always-on routine, no local machine required.

## Non-goals

- Auto-merging to `main`. The agent opens a PR; a human merges. `main` never moves unattended.
- Replacing the daily/weekly workflows or the `coil-sync` escalation contract. This rides on top.
- Resolving weekly full-build regressions (advisory only) — those stay human-investigated.

## Design

### Trigger & flow

```
daily sync → conflict/verify-fail/dropped-patch
   → opens coil-sync issue (status JSON + "▶ To fix: comment @claude resolve")
   → user comments  @claude resolve   (or runs the workflow manually)
   → coil-sync-resolve.yml runs Claude Code in CI:
        new branch coil/sync-<run_id> · git rebase upstream/main · resolve conflicts
        · review SEAMS.md semantics · vp run typecheck/lint/test
   → git push branch · gh pr create → main · comment PR link on the issue
   → user reviews + lands the PR by force-updating main to the reviewed tip
     (the branch is a rebase, so the GitHub merge button can't land it —
      see docs/coil/sync-agent-runbook.md § "Landing a sync PR")
```

### Component: `.github/workflows/coil-sync-resolve.yml`

- **Triggers:** `issue_comment` (created) and `workflow_dispatch`.
- **Gating (`if:`):** runs for a manual dispatch, **or** an `@claude resolve` comment on an
  issue (not a PR) that carries the `coil-sync` label **and** whose commenter is
  `OWNER`/`MEMBER`/`COLLABORATOR`. The `author_association` check is defense-in-depth on top of
  the action's built-in write-access requirement — critical on a public fork so a passer-by
  can't spend API budget.
- **Steps:** checkout `main` (full history) → configure git + add & fetch `upstream` (push
  disabled) → Setup Vite+ (`run-install`) → `anthropics/claude-code-action@v1` with a fixed
  `prompt` (runbook-derived) and `claude_args` (`--allowedTools`, `--max-turns`, `--model`).
- **Permissions:** `contents: write` (push branch), `pull-requests: write` (open PR),
  `issues: write` (comment). No `id-token` — auth is a stored token, not OIDC.
- **Model:** default `claude-sonnet-5`; a `workflow_dispatch` `model` choice input can bump to
  `claude-opus-5` for a gnarly merge.
- **Concurrency:** one resolve at a time (`cancel-in-progress: false`).

### Safety

Threat model: mostly "the LLM does something wrong," on a fork with a single trusted maintainer.

- **The trigger is the primary gate.** Only a manual dispatch, or an `@claude resolve` comment
  from an `OWNER`/`MEMBER`/`COLLABORATOR` on a `coil-sync`-labelled issue, runs the job. In agent
  mode the action does not itself enforce write-access, so this `if:` is what protects the API
  budget on the public fork.
- **No workflow injection.** Only trusted numerics (`github.run_id`, `github.event.issue.number`)
  and the constrained `model` choice are interpolated — never `comment.body`/issue title/body,
  and nothing untrusted reaches a `run:` shell. The prompt is fixed.
- **Prompt-injection containment.** Anyone can comment on the public escalation issue, and the
  action may surface that thread to the agent. The prompt marks all issue/comment/PR/commit text
  as untrusted data (never instructions) and forbids printing secrets. For stricter isolation,
  add `include_comments_by_actor: <owner>` to the action step.
- **`main` protection is by convention, not structure.** The job needs `contents: write` to push
  its branch, and that same token could technically force-push `main`. The agent is instructed to
  push only `coil/sync-*` + open a PR, and the **human PR-review gate** is the real backstop; if
  verify isn't green it opens a *draft* PR instead of claiming success. A branch-protection
  ruleset on `main` would enforce this structurally — but it would also block the daily sync's
  intentional `--force-with-lease` push to `main`, so adopting it means moving the daily job to a
  PR too. Left as an opt-in hardening.
- **Residual hardening (opt-in):** pin actions to commit SHAs (especially the third-party
  `voidzero-dev/setup-vp`); and note a PR opened with `GITHUB_TOKEN` does not trigger the repo's
  `pull_request` CI, so the reviewer relies on the agent's inline `vp run typecheck/lint/test`
  (use a GitHub App token if external required-checks are wanted).

### Auth / one-time setup (user)

Install the Claude GitHub App (`/install-github-app`) so the repo has the auth secret
(`CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY`). When prompted to add the generic
auto-responder workflow, **Skip** it — this repo ships its own `coil-sync-resolve.yml`, and a
generic `@claude` responder would double-fire on the same comment. The workflow references both
secret names so whichever the install flow set will work.

### Doc changes

- `coil-upstream-sync.yml` escalation body: add the `@claude resolve` call-to-action.
- `docs/coil/sync-agent-runbook.md`: rewrite from "daily scheduled routine" to this on-demand CI
  model, keeping the resolution checklist (which the workflow prompt mirrors) and a local-CLI
  fallback for when the user is at their machine.

## Deliverables

| Artifact | Path | Upstream conflict risk |
| --- | --- | --- |
| Resolver workflow | `.github/workflows/coil-sync-resolve.yml` | none (new file) |
| Escalation CTA | `.github/workflows/coil-upstream-sync.yml` (body text) | none (t3x-owned) |
| Runbook rewrite | `docs/coil/sync-agent-runbook.md` | none (t3x-owned) |
| This spec | `docs/superpowers/specs/2026-07-25-sync-conflict-agent-design.md` | none (new file) |

## Rollback

- Delete/disable `coil-sync-resolve.yml` (`gh workflow disable`). The daily sync still escalates
  the `coil-sync` issue; the user resolves locally via the runbook's fallback steps.
