# t3x seam ledger

**The authoritative list of every upstream-owned line this fork edits.**

The fork's entire conflict surface against `pingdotgg/t3code` is what appears below.
Everything else the fork adds lives in new, upstream-invisible files (`apps/**/t3x/…`,
`scripts/t3x/…`, `docs/t3x/…`, `.github/workflows/t3x-*.yml`) and can never conflict.

> **Rule:** a new feature registers itself inside `apps/server/src/t3x/index.ts`
> (or the equivalent per-surface aggregator) — **never** by adding a new edit to an
> upstream file. If a change genuinely cannot avoid touching upstream code, it gets a
> row here and a line in the "why unavoidable" column. If this table grows past a
> handful of rows, re-isolate rather than accept more daily sync pain.

## Server (`apps/server`)

| Upstream file | Edit | Why unavoidable |
|---|---|---|
| `apps/server/src/server.ts` | +1 import of `T3xLayerLive`, +1 `Layer.provideMerge(T3xLayerLive)` | The root layer graph is composed here; a feature layer must be merged into it at exactly one point. All feature layers fan in through `t3x/index.ts`, so this seam stays 2 lines no matter how many features are added. |
| `apps/server/src/serverRuntimeStartup.ts` | (only if a t3x reactor needs an explicit `.start()` — TBD by review) | Reactors that require an explicit start are kicked off here; see the auto-resume build for whether this row is needed. |

## Web (`apps/web`)

_None._ (v1 auto-resume ships with zero web changes; visibility rides existing
timeline activities.)

## Contracts / persistence

_None._ (No schema or migration changes — t3x state is a plain atomic-written JSON
file, deliberately avoiding the upstream-owned migration registry.)

---

## New files owned entirely by the fork (not seams — listed for orientation)

- `apps/server/src/t3x/**` — feature code + the `T3xLayerLive` aggregator.
- `scripts/t3x/**` — fork setup + upstream-sync scripts.
- `.github/workflows/t3x-upstream-sync.yml`, `.github/workflows/t3x-weekly-verify.yml`.
- `docs/t3x/**`, `docs/superpowers/specs/2026-07-23-*`.
