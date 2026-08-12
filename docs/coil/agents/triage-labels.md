# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

We kept the canonical names unchanged, so the mapping is the identity.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Status

All five exist on `radroid/t3code`. `wontfix` shipped with the repo; the other four were created
2026-08-05. **Do not re-create them** — `gh label create` on an existing label errors, and the
daily-sync agent has already been bitten once by a label race (PR #12).

## Labels outside this vocabulary

The fork carries labels that are **not** triage roles and should be left alone by `/triage`:

- `coil-sync` — machine-filed by the daily upstream-sync workflow. Not a human triage queue.
- `wayfinder:map`, `wayfinder:*` — owned by `/wayfinder`. See `docs/coil/agents/issue-tracker.md`.
- `bug`, `enhancement`, `documentation`, `dependencies`, `javascript`, and the other GitHub
  defaults — descriptive, orthogonal to triage state. An issue can carry both `enhancement` and
  `ready-for-agent`.

## `ready-for-agent` means the loop can take it

This is not a fork-neutral label here. The autonomous issue loop running in
`/Users/rajdholakia/Developer/t3code-work` picks work up off this label, so applying it is a
dispatch, not an annotation. Before applying it, the issue needs enough detail that an agent can
finish without asking a question — including which surfaces it must hit (web / desktop / mobile),
since `AGENTS.md` treats multi-surface support as non-negotiable.
