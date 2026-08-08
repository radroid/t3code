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

| Decision        | Choice                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| Capsule design  | **Variant D** — segmented `Off \| On`, so toggling never requires expanding                          |
| Tooltip         | **State-aware** — title always `Auto-resume`, second line carries the state detail                   |
| Tooltip side    | `side="bottom"` — the capsule sits under the topbar, so the tooltip opens down into open chat space  |
| Accessible name | `role="radiogroup"` + `aria-label="Auto-resume"` — a tooltip is _not_ an accessible name             |
| Placement       | **Top-right, under the topbar** — chosen by the user after hands-on use; see the revision note below |
| Testing         | Extract logic into framework-free modules; no new test dependency                                    |

Variants A/B/C were built as mockups only (`/tmp/t3x-autoresume-gallery/`) and are **not** shipped;
the runtime variant switcher was dropped once D was chosen.

## Placement detail

The capsule sits at `top-[calc(var(--workspace-topbar-height)+0.25rem)] right-3` — 56px down, so the
collapsed control spans roughly **56→82px** and clears the `sm`-and-up toast lane (which starts at
`--toast-inset + 52px` = 84px) by 2px.

### Revision, 2026-08-08 — reversed after hands-on use

An earlier revision of this spec anchored the capsule **bottom-right above the composer**, to escape
the toast collision documented under "Why". After using the built control the user asked for
top-right instead, and that is what ships.

Two consequences are accepted deliberately, not overlooked:

- A toast **will** cover the **expanded panel**, which opens downward straight into the toast lane.
- Below `sm`, `--toast-inset` drops to 1rem so the toast lane starts at 68px and spans nearly the
  full width — it will cover the **collapsed capsule** too.

Neither is fixable by z-index: the toast viewport is `fixed z-100` inside a portal at body level and
the overlay is `z-30` inside `SidebarInset`. If the overlap becomes annoying in practice, the
options are (a) return to bottom-right, (b) shift the capsule left of the 360px toast column, or
(c) subscribe to the toast manager and fade the capsule while toasts are visible.

**This revision deleted a seam.** Bottom anchoring needed the composer's dynamic height, measured
from upstream's `[data-chat-composer-overlay="true"]` via `ResizeObserver`. Top anchoring needs only
the `--workspace-topbar-height` CSS variable, so that read-only DOM dependency is gone and its row
has been removed from `docs/t3x/SEAMS.md`. The fork's upstream surface is back to zero additions
for this feature.

## Module split

| Module                          | Responsibility                                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t3x/autoResumeClient.ts`       | Wire parsing + GET/POST over `primaryEnvironmentHttpLayer`. Exposes an `AutoResumeClient` interface so tests inject a fake.                                                |
| `t3x/autoResumeController.ts`   | Framework-free lifecycle machine. Injected `client` + `timers`. Owns poll gating, optimistic toggle/rollback, in-flight counting, prompt debounce, flush-on-thread-change. |
| `t3x/autoResumePresentation.ts` | Pure formatters: status line, countdown, tooltip copy.                                                                                                                     |
| `t3x/AutoResumeOverlay.tsx`     | Thin React shell — `useSyncExternalStore` over the controller, renders variant D.                                                                                          |

`getSnapshot()` returns a **cached** object, recreated only when state or draft actually changes.
`useSyncExternalStore` re-invokes it on every render and will loop forever on a fresh reference.

## Behaviour preserved from the current implementation

These are load-bearing and each gets a test:

- A poll response must never stomp an optimistic value that has not round-tripped (`inFlightWrites > 0` gate).
- The in-flight counter must be released **exactly once** — including when URL construction throws
  _synchronously_, before a promise exists. A leaked increment stops polling for the component's life.
- A write result for a thread the user has already navigated away from is discarded.
- A debounced prompt edit is **flushed**, not dropped, when the thread changes or the overlay
  unmounts — and flushed under the _originating_ threadId.
- A failed toggle rolls back to the previous state.
- Any transport failure resolves to `null` so the overlay disappears rather than degrading the chat.

## Animation

The repo has **no `tailwindcss-animate` plugin**, so `animate-in` / `fade-in` / `slide-in-from-*`
utilities are inert here — they compile to nothing. Everything below uses Tailwind core utilities or
the base-ui `data-starting-style` / `data-ending-style` convention the `ui/` primitives already use.
Every animated element carries `motion-reduce:transition-none` (or `motion-reduce:animate-none`),
matching `AnimatedHeight.tsx` and `ContextWindowMeter.tsx`.

| Element          | Treatment                                                                                                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capsule entrance | Opacity + 4px drop from above, class flip driven by `requestAnimationFrame` on first paint; re-arms whenever the overlay reappears                                                                                                                                         |
| Off/On thumb     | A **single** element that translates (`translate-x-0` ⇄ `translate-x-full`) on `cubic-bezier(0.34, 1.56, 0.64, 1)` over 320ms — an overshoot-and-settle damped spring, so the fill reads as one body of colour flowing across rather than two backgrounds cross-fading     |
| Thumb colour     | 200ms plain ease-out, deliberately shorter than the 320ms travel so the colour has resolved before the spring settles instead of still shifting during the overshoot                                                                                                       |
| Segment labels   | `transition-colors duration-150`                                                                                                                                                                                                                                           |
| Panel expand     | `CollapsiblePanel` — base-ui height transition already in the primitive, grows downward from the capsule                                                                                                                                                                   |
| Chevron          | `rotate-0` ⇄ `rotate-180`, `transition-transform duration-200`                                                                                                                                                                                                             |
| Countdown        | `tabular-nums` **plus zero-padded minutes**. `tabular-nums` alone equalises digit widths but cannot stop the character _count_ changing — `10:00` → `9:59` drops a character and resized the capsule under the user's cursor. Padding pins sub-hour values at 5 characters |
| Tooltip          | base-ui `TooltipPopup` scale+opacity, already in the primitive                                                                                                                                                                                                             |

## Bug found while writing the tests

The in-flight-write counter that stops a poll from stomping an optimistic value was **global**, not
per-thread — in the shipped code as well as the first draft of the refactor. Switching threads while
a write was still in flight made the _new_ thread skip its initial load, leaving the overlay blank
for up to `POLL_INTERVAL_MS` (30s).

`inFlightWrites` is now a `Map<string, number>` keyed by thread, and `refresh()` consults only the
count for the thread it is about to read. Covered by _"loads a newly selected thread even while the
previous thread's write is in flight"_.

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
