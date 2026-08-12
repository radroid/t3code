# t3x — Per-thread auto-resume UI (design + implementation plan)

**Date:** 2026-07-24
**Fork:** `radroid/t3code`
**Parent feature:** `2026-07-23-usage-limit-auto-resume-design.md` (the headless server feature this adds UI to)
**For:** a fresh implementation agent. Self-contained. Branch: `t3x/autoresume-ui` off `main` (merge `t3x/setup-and-auto-resume` into `main` first).

## Goal

Give each thread a small, visible control for the existing (headless) auto-resume feature:

1. **Status** — is this loop going to be auto-resumed, and when ("next attempt ~3:47 PM").
2. **On/off toggle** — enable/disable auto-resume for _this thread_ (default on).
3. **Resume-message textbox** — the text sent on resume for this thread (default `"continue"`; already stored as `overridePrompt`).

Placement (decided): a **floating card** overlaying the thread view — lowest merge-conflict, self-positioning, no upstream layout cooperation.

## Guiding constraint (this is a fork)

Keep the upstream footprint at a **fixed, tiny seam** and touch **zero** `@t3tools/contracts` code and no hot chat files' logic. Target total upstream footprint:

- **+1 line** (+1 import) in `apps/server/src/server.ts` (mount the t3x HTTP route).
- **+1 line** (+1 import) in `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` (mount the overlay).
- Everything else is **new files** under `apps/server/src/coil/` and a new `apps/web/src/coil/`.

> Every concrete file path / line number / symbol below came from a codebase exploration and is a strong lead, **but the implementing agent MUST re-confirm each against the current code before editing** (upstream churn moves line numbers).

## Architecture (3 pieces)

### A. Status — mostly free

The reactor already appends per-thread timeline activities (`coil.auto-resume.scheduled|resumed|cancelled|capped` via `appendActivity` → `thread.activity.append` in `apps/server/src/coil/autoResume/Reactor.ts`), and the web already renders arbitrary activity kinds in the work-log (per exploration: `apps/web/src/.../session-logic.ts` `deriveWorkLogEntries` uses `activity.summary` and does not filter our kinds — **verify**). So a baseline status already surfaces in the timeline with no change.
The floating card additionally shows a **live** status ("auto-resume: on · next attempt ~3:47 PM") read from the GET endpoint below (returns the current pending, if any). Enrich wording only in our own `Reactor.ts` if desired — no seam.

### B. Persistence — a fork-owned raw HTTP route (NOT an RPC/contracts change)

Adding a WS-RPC method would force edits to `@t3tools/contracts` (`WsRpcGroup`, `WS_METHODS`), `apps/server/src/ws.ts` (churn 36/60d) and its scope map — high conflict. Instead:

- **New file `apps/server/src/coil/autoResume/http.ts`** exposing a raw `HttpRouter` with:
  - `GET  /api/coil/auto-resume?threadId=…` → `{ enabled, overridePrompt, pending: { resumeAtMs, reason } | null }`
  - `POST /api/coil/auto-resume` body `{ threadId, enabled?, overridePrompt? }` → writes to `AutoResumeStore`.
- **Auth:** copy the existing authenticated-raw-route pattern — mirror `otlpTracesProxyRouteLayer` / `authenticateRawRouteWithScope` in `server.ts` (same Bearer token + scope the web already holds). **Do not** create an unauthenticated endpoint. Confirm the exact helper name and required scope from the otlp route and reuse it verbatim.
- **Mount:** one additive line in `server.ts`'s `makeRoutesLayer` `mergeAll`, beside `otlpTracesProxyRouteLayer` (+1 import). This is the only server seam.
- **Sharing the store:** the route handler and the reactor must use the **same** `AutoResumeStore` instance. Wire `AutoResumeStoreLive` so it's visible to both the routes layer and the reactor (exploration flagged flipping `provide`→`provideMerge` for the store in `apps/server/src/coil/index.ts` — confirm the layer graph and make the store a shared dependency, not two instances).

### C. The control UI — new `apps/web/src/coil/`

- **New component** `apps/web/src/coil/AutoResumeOverlay.tsx` — a floating/absolute-positioned card. Reuses existing primitives: `ui/switch` (toggle) and `ui/textarea` (resume message). Shows the live status line.
- **Data:** an authenticated `fetch` to the route in (B), using the connection's `{ httpBaseUrl, httpAuthorization }` (find how the web already resolves these — likely an atom/context used by existing HTTP calls / `LocalApi`; reuse it). Debounce the textbox write; optimistic toggle.
- **Mount (the one web seam):** in `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`, add one import and render `<AutoResumeOverlay threadRef={threadRef} />` as a sibling of `<ChatView>` inside `<SidebarInset>` (~line 66; `threadRef` is already resolved there). This route is the server-thread view; the draft route is correctly excluded.

### D. State + gating (fork-owned, zero seam)

- **`apps/server/src/coil/autoResume/state.ts`:** add `enabled` to `ThreadRecord` as **optional with default true** (`Schema.optionalWith(Schema.Boolean, { default: () => true })` or equivalent) so pre-existing state files still decode. Add a `setEnabled(threadId, enabled)` mutation and a `setOverridePrompt(threadId, text)` mutation (the store already carries `overridePrompt`; add the setter).
- **`apps/server/src/coil/autoResume/Reactor.ts`:** gate on `enabled`. In detection (`onRuntimeEvent`) skip scheduling when the thread is disabled; in `fireOne` treat disabled as a cancel reason (clear pending, optional activity note). Simplest: check `record.enabled !== false` in detection, and re-check in `fireOne` against a fresh read.

## Data flow

```
toggle/textbox → fetch POST /api/coil/auto-resume → AutoResumeStore.setEnabled / setOverridePrompt (durable JSON)
reactor detection/fireOne → reads enabled + overridePrompt from the same store
card status ← fetch GET /api/coil/auto-resume ← AutoResumeStore (enabled, overridePrompt, current pending)
timeline status ← existing activity notes (no change)
```

## Implementation phases

**Phase 1 — server state + gating (no UI yet).**

- Add `enabled` (optional, default true) + `setEnabled`/`setOverridePrompt` to `state.ts`.
- Gate detection + `fireOne` on `enabled` in `Reactor.ts`.
- Tests: extend `state.test.ts` (enabled round-trips, defaults true, old file without the field decodes to enabled=true); extend `Reactor.test.ts` (disabled thread neither schedules nor fires).
- Verify: `pnpm run test src/t3x` green; `pnpm run typecheck` clean.

**Phase 2 — the HTTP route.**

- `http.ts` GET/POST over the shared `AutoResumeStore`, authenticated like `otlpTracesProxyRouteLayer`.
- Share the store instance; mount via the single `server.ts` line (+import).
- Test: a route-level test (auth required; GET/POST round-trip through a real store). Confirm an unauthenticated request is rejected.
- Verify: typecheck + tests; `curl` the route against a locally booted server with the bearer token (see the parent conversation's headless-boot recipe) and confirm read/write.

**Phase 3 — the web overlay.**

- `apps/web/src/coil/AutoResumeOverlay.tsx` + the single mount line in the chat route file.
- Resolve `{ httpBaseUrl, httpAuthorization }` the same way existing web HTTP calls do; debounce textbox; optimistic toggle; render live status.
- Verify: `pnpm run typecheck`; web lint; manual check in a locally built app — toggle persists across reload, textbox persists, status reflects a scheduled resume.

**Phase 4 — docs + seam ledger.**

- Update `docs/coil/SEAMS.md`: record the 2 new seams (server.ts route mount; web route-file overlay mount) and confirm contracts untouched.
- Update the parent auto-resume spec's B7 ("zero UI") to point here.

## Guardrails (do not violate)

- **Zero edits to `@t3tools/contracts`.** No new RPC method, no settings-schema field.
- **No logic edits to hot chat files** (`ChatView.tsx` 51/60d, `ChatComposer` 30, `ws.ts` 36). The only upstream edits are the two additive mount lines named above.
- New code lives under `apps/server/src/coil/` and `apps/web/src/coil/` only.
- Follow Effect v4 conventions already used in `t3x/autoResume/*` (`Effect.catch`/`catchCause`, `Context.Service`, no `new Date()`/`Math.random`).

## Out of scope (v1)

- Global defaults UI (a `/settings` section). Low-conflict to add later (new route file + one nav line) but only holds global defaults, not per-thread state — skip unless wanted.
- Manual "resume now" / "cancel scheduled resume" buttons — easy follow-ups on the same route; not required for this ask.
