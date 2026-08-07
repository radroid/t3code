# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

**Layout: single-context**, held entirely inside the fork-owned `docs/t3x/` namespace. This repo is
a pnpm monorepo and would normally suggest a multi-context layout, but it is a **fork** of
`pingdotgg/t3code`: per-context `CONTEXT.md` files would have to live inside `apps/*` and
`packages/*`, which upstream owns. Keeping one context under `docs/t3x/` costs zero rebase surface.
See `docs/t3x/SEAMS.md`.

## Before exploring, read these

- **`docs/t3x/CONTEXT.md`** — the fork's glossary. Covers `t3x` vocabulary only.
- **`docs/t3x/adr/`** — read ADRs that touch the area you're about to work in.
- **`docs/internals/glossary.md`** — **upstream's** glossary, and the authority for the product's
  core vocabulary (commands, deciders, events, projectors, adapters, reactors, receipts,
  checkpoints). Read this first when the concept is not fork-specific.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## Two glossaries, one rule

Upstream's glossary is authoritative for the product; the fork's is authoritative only for what the
fork adds. When a term appears in both, **upstream wins** — the fork inheriting a divergent
definition is how a silent semantic drift starts.

`docs/t3x/CONTEXT.md` should therefore stay small: it defines things like the `t3x` seam, the thread
outbox, auto-resume, needs-input notifications, and the sync agent — not `thread`, `turn`, or
`checkpoint`.

## File structure

```
/
├── docs/
│   ├── internals/glossary.md          ← upstream's glossary (read-only; do not edit)
│   └── t3x/
│       ├── CONTEXT.md                 ← the fork's glossary
│       ├── SEAMS.md                   ← the upstream-file seam ledger
│       ├── adr/
│       │   ├── 0001-....md
│       │   └── 0002-....md
│       └── agents/                    ← this file, plus tracker + label config
└── apps/, packages/                   ← upstream-owned; no CONTEXT.md goes here
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the glossary. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in either glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_

## Flag seam-ledger conflicts too

`docs/t3x/SEAMS.md` is a domain doc in everything but name: it records which upstream files the fork
edits and why. If your change touches a file with a row there, or would add a new row, say so
explicitly — and update the ledger **in the same commit**. The ledger measures the tree the commit
creates, not the tree it started from, so a commit that edits a seam and leaves the row alone makes
the document wrong the moment it lands.
