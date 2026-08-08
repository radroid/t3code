# t3x — Auto-resume overlay: variant D + testability refactor

**Date:** 2026-08-08
**Fork:** `radroid/t3code`
**Supersedes the UI section of:** `2026-07-24-t3x-autoresume-ui-design.md` (§C, "The control UI")
**Scope:** `apps/web/src/t3x/` only. Zero upstream edits — the existing mount line in
`_chat.$environmentId.$threadId.tsx` keeps the same props, so the hottest seam (churn 80) is untouched.

## Why

Two problems with the shipped overlay, found by rendering it against the app's real tokens:

1. **It is hidden behind toasts.** The toast viewport is `fixed z-100` inside a `Toast.Portal`
   at body level; the overlay is `z-30` inside `SidebarInset`. The overlay can never win on
   z-index alone.
   - **≥640px** (`--toast-inset: 2rem` → toast top `84px`): the collapsed capsule spans
     `60→86px`, a ~2px graze; the **expanded panel is fully covered**.
   - **<640px** (`--toast-inset: 1rem` → toast top `68px`, full-bleed width): the toast covers
     the **collapsed capsule** outright. Auto-resume state is invisible on phones whenever any
     toast is up — and "thread finished" toasts fire exactly when a usage-limit pause is likely.
2. **It has no tests.** All of the async lifecycle — poll gating, optimistic toggle, in-flight
   write counting, debounce-flush across thread changes — is tangled into the component with a
   module-scope `ManagedRuntime` and direct `window` timer access. Only `formatAutoResumeStatus`
   was reachable from a test. The server side has six test files; the web side had none.

## Decisions

| Decision | Choice |
|---|---|
| Capsule design | **Variant D** — segmented `Off \| On`, so toggling never requires expanding |
| Tooltip | **State-aware** — title always `Auto-resume`, second line carries the state detail |
| Tooltip side | `side="top"` (the `TooltipPopup` default) — correct *because* of the bottom placement below |
| Accessible name | `role="radiogroup"` + `aria-label="Auto-resume"` — a tooltip is *not* an accessible name |
| Placement | **Bottom-right, above the composer** — clear of the top-positioned toast lane at every breakpoint |
| Testing | Extract logic into framework-free modules; no new test dependency |

Variants A/B/C were built as mockups only (`/tmp/t3x-autoresume-gallery/`) and are **not** shipped;
the runtime variant switcher was dropped once D was chosen.

## Placement detail

The overlay moves from `top-[calc(var(--workspace-topbar-height)+0.5rem)] right-3` to bottom-right,
offset above the composer. It adopts the same idiom as upstream's **"Scroll to end"** pill
(`ChatView.tsx`), which sits just above the composer with identical capsule classes — that pill is
horizontally *centered*, so a right-aligned capsule does not collide with it.

The composer's height is dynamic (multi-line input, banner stack), so the offset is measured from
upstream's existing `[data-chat-composer-overlay="true"]` element via `ResizeObserver`, the same
element `ChatView` measures for its own `composerOverlayHeight`.

Two consequences of anchoring to the bottom, both confirmed against the rendered preview:

- **The tooltip opens upward.** `side="top"` — the `TooltipPopup` default — is now the correct
  value. (An earlier draft of this spec said `side="bottom"`; that was right only while the capsule
  sat under the topbar, and is wrong here.)
- **The expanded panel grows upward**, via `flex-direction: column-reverse` on the overlay
  container, so it never pushes down into the composer.

> **New soft seam.** This is a *read-only DOM dependency* on an upstream attribute, not a code edit.
> It degrades gracefully: if the element is absent the overlay falls back to a fixed offset and stays
> usable. Recorded in `docs/t3x/SEAMS.md`.

## Module split

| Module | Responsibility |
|---|---|
| `t3x/autoResumeClient.ts` | Wire parsing + GET/POST over `primaryEnvironmentHttpLayer`. Exposes an `AutoResumeClient` interface so tests inject a fake. |
| `t3x/autoResumeController.ts` | Framework-free lifecycle machine. Injected `client` + `timers`. Owns poll gating, optimistic toggle/rollback, in-flight counting, prompt debounce, flush-on-thread-change. |
| `t3x/autoResumePresentation.ts` | Pure formatters: status line, countdown, tooltip copy. |
| `t3x/AutoResumeOverlay.tsx` | Thin React shell — `useSyncExternalStore` over the controller, renders variant D. |

`getSnapshot()` returns a **cached** object, recreated only when state or draft actually changes.
`useSyncExternalStore` re-invokes it on every render and will loop forever on a fresh reference.

## Behaviour preserved from the current implementation

These are load-bearing and each gets a test:

- A poll response must never stomp an optimistic value that has not round-tripped (`inFlightWrites > 0` gate).
- The in-flight counter must be released **exactly once** — including when URL construction throws
  *synchronously*, before a promise exists. A leaked increment stops polling for the component's life.
- A write result for a thread the user has already navigated away from is discarded.
- A debounced prompt edit is **flushed**, not dropped, when the thread changes or the overlay
  unmounts — and flushed under the *originating* threadId.
- A failed toggle rolls back to the previous state.
- Any transport failure resolves to `null` so the overlay disappears rather than degrading the chat.

## Animation

The repo has **no `tailwindcss-animate` plugin**, so `animate-in` / `fade-in` / `slide-in-from-*`
utilities are inert here — they compile to nothing. Everything below uses Tailwind core utilities or
the base-ui `data-starting-style` / `data-ending-style` convention the `ui/` primitives already use.
Every animated element carries `motion-reduce:transition-none` (or `motion-reduce:animate-none`),
matching `AnimatedHeight.tsx` and `ContextWindowMeter.tsx`.

| Element | Treatment |
|---|---|
| Capsule entrance | Opacity + 4px rise, class flip driven by `requestAnimationFrame` on first paint; re-arms whenever the overlay reappears |
| Off/On thumb | A **single** element that translates (`translate-x-0` ⇄ `translate-x-full`) with `transition-[transform,background-color] duration-150` — a slide, not two backgrounds cross-fading |
| Segment labels | `transition-colors duration-150` |
| Panel expand | `CollapsiblePanel` — base-ui height transition already in the primitive, grows upward via `flex-col-reverse` |
| Chevron | `rotate-180` ⇄ `rotate-0`, `transition-transform duration-200` |
| Countdown | `tabular-nums`; without it the capsule visibly jitters as digits tick |
| Tooltip | base-ui `TooltipPopup` scale+opacity, already in the primitive |

## Bug found while writing the tests

The in-flight-write counter that stops a poll from stomping an optimistic value was **global**, not
per-thread — in the shipped code as well as the first draft of the refactor. Switching threads while
a write was still in flight made the *new* thread skip its initial load, leaving the overlay blank
for up to `POLL_INTERVAL_MS` (30s).

`inFlightWrites` is now a `Map<string, number>` keyed by thread, and `refresh()` consults only the
count for the thread it is about to read. Covered by *"loads a newly selected thread even while the
previous thread's write is in flight"*.

## Test plan

**Server** — extend `autoResume/http.test.ts`: `POST` with a cancel action clears pending, still
requires operate scope, unknown action → 400.

**Web** (all new):

- `autoResumeClient.test.ts` — parser edge cases (non-object, array, missing `enabled`, non-finite
  `resumeAtMs`, empty `overridePrompt` → `null`), non-200 → `null`, transport throw → `null`.
- `autoResumeController.test.ts` — every bullet in "Behaviour preserved" above, driven by a fake
  client and fake timers.
- `autoResumePresentation.test.ts` — status strings, countdown (past-due, >1h, zero), tooltip copy
  per state.
- `AutoResumeOverlay.test.tsx` — `renderToStaticMarkup` across off/on/pending, asserting the
  `radiogroup` label, `aria-checked` per segment, and the countdown.

No new test dependency: this matches the repo's existing no-DOM pattern (`AppRoot.test.tsx`,
`markdown-list-indentation.test.tsx`).

## Out of scope

- **"Resume now."** Firing outside the reactor's guard pipeline could resume a thread straight into
  a blocking prompt — the exact class of bug `guards.ts` exists to prevent. Needs its own design pass.
- Global defaults UI (`/settings` section) — unchanged from the v1 spec.
