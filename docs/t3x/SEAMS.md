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

| Upstream file               | Edit                                                                                                                                                                   | Why unavoidable                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/server.ts` | +1 import of `T3xLayerLive` **and `T3xRoutesLive`** (one statement), +1 `Layer.provideMerge(T3xLayerLive)`, +1 `T3xRoutesLive` entry in `makeRoutesLayer`'s route list | The root layer graph and the route list are both composed here, so a feature layer and a feature route each need exactly one mount point. Both fan in through `t3x/index.ts` — the import is one statement and the route list one entry — so this seam stays 3 lines no matter how many features or routes are added. |

> The auto-resume reactor **self-starts** via `Effect.forkScoped` at layer construction,
> so — unlike the built-in reactors — it needs **no** `.start()` call in
> `serverRuntimeStartup.ts` or `OrchestrationReactor.ts`. Those files stay untouched.

## Logic mirrors (semantic dependencies, not code seams)

These are upstream helpers whose logic the fork **replicates** (rather than imports, to
avoid a code seam). They don't conflict during rebase, but if upstream changes the
original's behavior the mirror can drift silently — the daily sync agent must diff these
originals when they change.

| Fork mirror                                                               | Mirrors upstream                                                       | Risk if upstream changes                                                                                                                                                  |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/t3x/autoResume/guards.ts` (`hasOpenBlockingRequest`)     | `decider.ts:57-80` (private, unexported)                               | Awaiting-approval guard could miss a new blocking-request activity kind and auto-resume into a prompt.                                                                    |
| `apps/server/src/t3x/autoResume/http.ts` (`authenticateWithOperateScope`) | `http.ts:78-95` (`authenticateRawRouteWithScope`, private, unexported) | If upstream changes how raw routes authenticate (new error case, different scope check), `/api/t3x/auto-resume` could authenticate more weakly than the routes beside it. |

## Web (`apps/web`)

| Upstream file                                            | Edit                                                          | Why unavoidable                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` | +1 import, +1 `<AutoResumeOverlay />` sibling of `<ChatView>` | A per-thread overlay has to be rendered by the thread route; there is no extension point. Chosen as a floating card precisely so it needs no cooperation from upstream layout — no `ChatView.tsx` / `ChatComposer` edits (both hot files). |

> The overlay ships to the **desktop app too**: `apps/desktop` is an Electron shell that
> loads this same web bundle from `t3code://app`, so there is no separate desktop UI to
> change. `apps/mobile` is a distinct React Native codebase and does **not** get it.

## Contracts / persistence

_None._ (No schema or migration changes — t3x state is a plain atomic-written JSON
file, deliberately avoiding the upstream-owned migration registry.)

---

## New files owned entirely by the fork (not seams — listed for orientation)

- `apps/server/src/t3x/**` — feature code + the `T3xLayerLive` aggregator.
- `scripts/t3x/**` — fork setup + upstream-sync scripts.
- `.github/workflows/t3x-upstream-sync.yml`, `.github/workflows/t3x-weekly-verify.yml`.
- `docs/t3x/**`, `docs/superpowers/specs/2026-07-23-*`.
