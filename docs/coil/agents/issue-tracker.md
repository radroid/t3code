# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues on **`radroid/t3code`** — the fork, not
upstream. Use the `gh` CLI for all operations.

> **Fork hazard — read this first.** This repo has two remotes: `origin` (`radroid/t3code`) and
> `upstream` (`pingdotgg/t3code`). `gh` resolves a fork's default repo to its **parent** unless
> told otherwise, so an unpinned `gh issue create` can land on upstream's tracker. That has already
> happened once here (fixed in PR #18).
>
> Locally this is pinned — `.git/config` carries `remote.origin.gh-resolved = base`, and git
> worktrees (`t3code-work`, `t3code-loop`, `t3code-build`) share that config, so interactive use is
> safe. **Fresh clones and CI are not.** In any script, workflow, or non-interactive agent run,
> export `GH_REPO=radroid/t3code` explicitly rather than relying on inference.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

### Sync PRs are not button-mergeable

Branches named `t3x/sync-<id>` are rebases onto upstream, not merges. GitHub's merge button will
refuse or produce the wrong history. Land them with:

```bash
git push --force-with-lease origin t3x/sync-<id>:main
```

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `radroid/t3code`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

Both GitHub features below were verified available on `radroid/t3code` (2026-08-05): the
`sub_issues` and `dependencies/blocked_by` endpoints respond, and `gh api repos/radroid/t3code/issues/<n>`
returns both `sub_issues_summary` and `issue_dependencies_summary`. Use the native mechanisms — the
body-convention fallbacks below are documented only in case the features are later disabled.

- **Map**: a single issue labelled `wayfinder:map`, holding the Destination / Notes /
  Decisions-so-far / Not-yet-specified / Out-of-scope body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue. Add with the numeric
  **database id** of the child, not its `#number`:

  ```bash
  child_id=$(gh api repos/radroid/t3code/issues/<child> --jq .id)
  gh api --method POST repos/radroid/t3code/issues/<map>/sub_issues -F sub_issue_id="$child_id"
  ```

  Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is
  assigned to the driving dev. _Fallback:_ a task list in the map body plus `Part of #<map>` at the
  top of the child body.

- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation.

  ```bash
  blocker_id=$(gh api repos/radroid/t3code/issues/<blocker> --jq .id)
  gh api --method POST repos/radroid/t3code/issues/<child>/dependencies/blocked_by -F issue_id="$blocker_id"
  ```

  Again the **database id**, not the `#number` or `node_id`. GitHub reports
  `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). _Fallback:_ a
  `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every
  blocker is closed.

- **Frontier query**: list the map's open children, drop any with an open blocker or an assignee;
  first in map order wins.

  ```bash
  gh api repos/radroid/t3code/issues/<map>/sub_issues \
    --jq '.[] | select(.state == "open")
             | select(.assignee == null)
             | select(.issue_dependencies_summary.blocked_by == 0)
             | {number, title}'
  ```

- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a
  context pointer (gist + link) to the map's Decisions-so-far.

### Labels wayfinder needs

`wayfinder:map` and the four `wayfinder:<type>` labels do **not** exist yet — the first charting
session should create them:

```bash
gh label create wayfinder:map --color 5319E7 --description "A wayfinder map issue"
gh label create wayfinder:research --color B4A8E8 --description "Wayfinder ticket: AFK research"
gh label create wayfinder:prototype --color B4A8E8 --description "Wayfinder ticket: HITL prototype"
gh label create wayfinder:grilling --color B4A8E8 --description "Wayfinder ticket: HITL conversation"
gh label create wayfinder:task --color B4A8E8 --description "Wayfinder ticket: manual unblocking work"
```

### Existing label collision

The fork already uses `t3x-sync` for the daily upstream-sync escalation. Those issues are
machine-filed and are **not** part of the wayfinder or triage flow — skip them when querying the
frontier or the triage queue.
