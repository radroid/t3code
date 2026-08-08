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

| Decision        | Choice                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------ |
| Capsule design  | **Variant D** — segmented `Off \| On`, so toggling never requires expanding                |
| Tooltip         | **State-aware** — title always `Auto-resume`, second line carries the state detail         |
| Tooltip side    | `side="top"` (the `TooltipPopup` default) — correct because the capsule sits at the bottom |
| Accessible name | `role="radiogroup"` + `aria-label="Auto-resume"` — a tooltip is _not_ an accessible name   |
| Placement       | **Bottom-right, immediately above the composer** — see the revision history below          |
| Testing         | Extract logic into framework-free modules; no new test dependency                          |

Variants A/B/C were built as mockups only (`/tmp/t3x-autoresume-gallery/`) and are **not** shipped;
the runtime variant switcher was dropped once D was chosen.

## Placement detail

The capsule sits **bottom-right, immediately above the docked composer**, tracking the composer's
height so it stays glued to the input as that grows. It reads as belonging to the input rather than
floating over the transcript, and it inherits a useful property for free: the toast lane is
top-anchored, so a bottom-anchored capsule can never be covered by a toast.

The composer's height is dynamic (multi-line input, banner stack), so the offset is measured from
upstream's existing `[data-chat-composer-overlay="true"]` element via `ResizeObserver` — the same
element `ChatView` measures for its own `composerOverlayHeight`. The measurement is clamped to
240px, because that element stretches to `inset-0` in the draft-hero state and an unclamped read
would fling the capsule to the top of the thread.

> **New soft seam.** A _read-only DOM dependency_ on an upstream attribute, not a code edit. It
> degrades gracefully: if the element is absent the overlay falls back to a fixed 76px offset and
> stays usable. Recorded in `docs/t3x/SEAMS.md`.

Consequences of anchoring to the bottom:

- **The tooltip opens upward.** `side="top"` — the `TooltipPopup` default.
- **The expanded panel grows upward**, via `flex-direction: column-reverse`, so it never pushes down
  into the composer.

### Sharing the band above the composer

Everything else that can appear in this strip, and how the capsule behaves with it:

| Neighbour                                                                                                       | Where it renders                                                                               | Interaction                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ComposerBannerStack` — environment-unavailable, server-version update, thread snoozed/settled, branch-mismatch | **In flow inside** the measured composer overlay                                               | Overlay grows, `ResizeObserver` fires, capsule rises with it. Verified clear at 0/60/90/130/200px banner heights with a constant 16px gap                                    |
| `ThreadSyncStatusPill`                                                                                          | In flow inside the same overlay                                                                | Same as above                                                                                                                                                                |
| `ThreadOutboxQueueList` (fork)                                                                                  | Inside the composer card                                                                       | Same as above                                                                                                                                                                |
| **"Scroll to end" pill**                                                                                        | `absolute`, centred, `bottom: composerOverlayHeight + 4` — a _sibling_, not inside the overlay | **Collides at narrow widths.** Shares the same vertical band (24px overlap) and is centred while the capsule is right-aligned, so they meet once the column is narrow enough |
| Toast viewport                                                                                                  | `fixed z-100`, top-anchored, body-level portal                                                 | No interaction — the capsule is bottom-anchored                                                                                                                              |

The scroll-to-end overlap is measured, not predicted: at **520px** wide they clear by 34px; at **390px**
they overlap by **31px**. The crossover is where `capsule.left` falls below the centred pill's right
edge. It is **not fixed** — every available fix costs either a magic breakpoint or a hard-coded
assumption about the pill's width, so it is recorded here for a decision rather than guessed at.

### Why the composer measurement tracks the top edge, not the height

The offset is `parentRect.bottom - overlayRect.top`, with the draft-hero state detected by the
overlay filling its container rather than by any bound on the result. Two earlier versions bounded
the measurement and both cut in during ordinary use:

- **240px absolute cap** — the docked composer already measures ~204px, so a single banner exceeded
  it. The capsule froze and banners rendered over it, from 80px of banner upward.
- **Fraction-of-container cap (0.5, then 0.66)** — still bound by a 90px banner on a 600px-tall
  window.

A bound cannot tell "tall because of banners" (must track) from "tall because of hero" (must not).
The height-versus-container ratio can, so the docked path now has no bound at all.

### Revision history

This placement was briefly changed to **top-right under the topbar** and then changed back, both
times at the user's direction after hands-on use. The final ask — "just right above the input box" —
is the bottom-right anchoring described above.

The top-right detour is worth recording because it had a real cost and a real benefit:

- **Benefit:** it needed only the `--workspace-topbar-height` CSS variable, so it deleted the
  `ResizeObserver` seam above. Restoring bottom anchoring restores that seam.
- **Cost:** it reintroduced the toast collision this design originally existed to fix. The toast
  viewport is `fixed z-100` in a portal at body level; this overlay is `z-30` inside `SidebarInset`,
  so no z-index change can win. Top-right meant a toast covered the expanded panel, and below `sm`
  (`--toast-inset` → 1rem, lane starts at 68px, full width) covered the collapsed capsule outright.

Bottom-right avoids the collision entirely and costs one read-only attribute dependency. That is the
trade this spec settles on.

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
