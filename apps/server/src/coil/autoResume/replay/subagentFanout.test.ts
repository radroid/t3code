/**
 * Multi-subagent fan-out scenarios.
 *
 * A T3 turn can fan out into many background subagents inside ONE thread turn. They hit
 * the provider independently, so a usage limit does not arrive as a single tidy event at
 * the end of the work — one subagent is rejected while the others keep running, and the
 * thread stays busy long after the arm was placed.
 *
 * That ordering is what these scenarios probe: the reactor arms on the FIRST rejection,
 * but re-checks its guards against a FRESH snapshot at fire time (Reactor.ts:190-222).
 * Whether an arm survives therefore depends on what the rest of the fan-out is doing hours
 * later, which nothing in the existing tests covers.
 *
 * Modelled on radroid/t3code#118, an overnight `/loop` whose work was fanned out through
 * background subagents.
 */

import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { AutoResumeReactorLive } from "../Reactor.ts";
import {
  appendedActivityKinds,
  appendedActivitySummaries,
  dispatchedTypes,
  makeReplayHarness,
  readModel,
  REPLAY_THREAD_ID,
  settleQuiet,
  settleUntil,
  threadRow,
} from "./reactorHarness.ts";

/**
 * A rejection carrying the hard-block shape observed in real captures: the five-hour
 * window rejected with overage unavailable to cover it.
 */
const rejection = (options: {
  readonly resetsAtSeconds: number;
  readonly eventId: string;
}): ProviderRuntimeEvent =>
  ({
    type: "account.rate-limits.updated",
    eventId: options.eventId,
    provider: "claudeAgent",
    threadId: REPLAY_THREAD_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      rateLimits: {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: options.resetsAtSeconds,
          overageStatus: "rejected",
          overageDisabledReason: "org_level_disabled",
          isUsingOverage: false,
        },
      },
    },
  }) as unknown as ProviderRuntimeEvent;

/** Defaults put the reset at 100s, so the resume is due at 160s (60s safety margin). */
const RESET_SECONDS = 100;

/** A thread mid-fan-out: session running, one long turn in flight. */
const busyThread = () =>
  threadRow({ sessionStatus: "running", latestTurn: { turnId: "turn-1", state: "running" } });

/** The same thread after everything finished: idle, turn settled away (see #6). */
const idleThread = () => threadRow({ sessionStatus: "ready", latestTurn: null });

const pendingCountIs = (
  store: { readonly listPending: Effect.Effect<ReadonlyArray<unknown>> },
  expected: number,
) => store.listPending.pipe(Effect.map((pending) => pending.length === expected));

const advanceSteps = (steps: number) =>
  Effect.gen(function* () {
    for (let step = 0; step < steps; step++) {
      yield* TestClock.adjust(Duration.millis(30_000));
      yield* settleQuiet;
    }
  });

describe("subagent fan-out — an arm placed while other agents keep working", () => {
  it.effect(
    "DESTROYS the arm when the fan-out is still running as the window reopens, and never re-arms",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeReplayHarness({
          events: [rejection({ resetsAtSeconds: RESET_SECONDS, eventId: "evt-subagent-1" })],
          initialModel: readModel([busyThread()]),
        });

        yield* Effect.gen(function* () {
          yield* settleUntil(pendingCountIs(harness.store, 1), "the first rejection to arm");

          // The rest of the fan-out is still working when the window reopens — the whole
          // point of the theory. Advance well past the due time without touching the model.
          yield* advanceSteps(10);

          const commands = yield* Ref.get(harness.dispatched);
          expect(dispatchedTypes(commands)).not.toContain("thread.turn.start");
          expect(appendedActivityKinds(commands)).toContain("coil.auto-resume.cancelled");
          // Pin the REASON, not just the fact. Without this the test would also pass if
          // the arm died as "thread-advanced" or "not-claude", which are different bugs.
          expect(appendedActivitySummaries(commands)).toContain(
            "Auto-resume cancelled: progressing.",
          );

          // The arm is GONE, not deferred.
          expect(yield* harness.store.listPending).toHaveLength(0);

          // Now the fan-out finishes and the thread goes idle — exactly when a resume is
          // wanted. Nothing re-arms it, because re-arming requires a NEW rejection event
          // and the limit already fired all of its telemetry hours ago.
          yield* Ref.set(harness.modelRef, readModel([idleThread()]));
          yield* advanceSteps(10);

          expect(yield* harness.store.listPending).toHaveLength(0);
          expect(dispatchedTypes(yield* Ref.get(harness.dispatched))).not.toContain(
            "thread.turn.start",
          );
          expect(yield* harness.store.countFiredSince(REPLAY_THREAD_ID, 0)).toBe(0);
        }).pipe(Effect.provide(AutoResumeReactorLive.pipe(Layer.provideMerge(harness.deps))));
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("CONTROL: the same arm fires when the fan-out finishes before the window reopens", () =>
    Effect.gen(function* () {
      const harness = yield* makeReplayHarness({
        events: [rejection({ resetsAtSeconds: RESET_SECONDS, eventId: "evt-subagent-1" })],
        initialModel: readModel([busyThread()]),
      });

      yield* Effect.gen(function* () {
        yield* settleUntil(pendingCountIs(harness.store, 1), "the first rejection to arm");

        // Same arm, same baseline; the only difference from the case above is that the
        // fan-out drains BEFORE the due time. This isolates "still running at fire time"
        // as the sole cause, rather than anything about how the arm was placed.
        yield* Ref.set(harness.modelRef, readModel([idleThread()]));
        yield* advanceSteps(10);

        const commands = yield* Ref.get(harness.dispatched);
        expect(dispatchedTypes(commands)).toContain("thread.turn.start");
        expect(appendedActivityKinds(commands)).toContain("coil.auto-resume.resumed");
        expect(yield* harness.store.countFiredSince(REPLAY_THREAD_ID, 0)).toBe(1);
      }).pipe(Effect.provide(AutoResumeReactorLive.pipe(Layer.provideMerge(harness.deps))));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("a SINGLE busy poll tick is enough to lose the resume permanently", () =>
    Effect.gen(function* () {
      // The sharpest statement of the defect. `processDue` (Reactor.ts:262-267) selects
      // everything due and calls `fireOne` once per item; `fireOne` either fires or
      // cancels. There is no retry and no deferral, so the arm only has to collide with
      // ONE 30s poll while a straggler subagent is mid-response. The thread going idle two
      // seconds later cannot help — the arm is already gone.
      const harness = yield* makeReplayHarness({
        events: [rejection({ resetsAtSeconds: RESET_SECONDS, eventId: "evt-straggler" })],
        initialModel: readModel([busyThread()]),
      });

      yield* Effect.gen(function* () {
        yield* settleUntil(pendingCountIs(harness.store, 1), "the rejection to arm");

        // Due at 160s; polls land on 30s multiples, so 180s is the first and only chance.
        yield* advanceSteps(6);
        // `advanceSteps` ends in `settleQuiet`, a fixed 10-pump spin that reactorHarness.ts
        // documents as too short whenever the state change is gated behind the store's
        // filesystem write — the same race that took CI red on 2026-08-07. Destruction is
        // such a change, so wait for it to land rather than looking once and hoping.
        yield* settleUntil(pendingCountIs(harness.store, 0), "the collided arm to be destroyed");
        expect(yield* harness.store.listPending).toHaveLength(0);

        // The straggler finishes immediately afterwards. Too late.
        yield* Ref.set(harness.modelRef, readModel([idleThread()]));
        yield* advanceSteps(20);

        expect(dispatchedTypes(yield* Ref.get(harness.dispatched))).not.toContain(
          "thread.turn.start",
        );
        expect(yield* harness.store.countFiredSince(REPLAY_THREAD_ID, 0)).toBe(0);
      }).pipe(Effect.provide(AutoResumeReactorLive.pipe(Layer.provideMerge(harness.deps))));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("many subagents rejected at once produce exactly one arm", () =>
    Effect.gen(function* () {
      // Five subagents hit the same window within seconds of each other. Dedupe must hold,
      // or the timeline fills with duplicate "scheduled" notes.
      const harness = yield* makeReplayHarness({
        events: [1, 2, 3, 4, 5].map((n) =>
          rejection({ resetsAtSeconds: RESET_SECONDS, eventId: `evt-subagent-${n}` }),
        ),
        initialModel: readModel([busyThread()]),
      });

      yield* Effect.gen(function* () {
        yield* settleUntil(pendingCountIs(harness.store, 1), "the first rejection to arm");
        yield* settleQuiet;

        expect(yield* harness.store.listPending).toHaveLength(1);
        const scheduled = appendedActivityKinds(yield* Ref.get(harness.dispatched)).filter(
          (kind) => kind === "coil.auto-resume.scheduled",
        );
        expect(scheduled).toHaveLength(1);
      }).pipe(Effect.provide(AutoResumeReactorLive.pipe(Layer.provideMerge(harness.deps))));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("a later subagent naming a later window pushes the arm out", () =>
    Effect.gen(function* () {
      // Subagents can be rejected by DIFFERENT buckets — a five_hour wall first, then a
      // seven_day wall that reopens much later. The arm must move to the later time, or it
      // fires into a door that is still shut and burns an attempt (radroid/t3code#39).
      const harness = yield* makeReplayHarness({
        events: [
          rejection({ resetsAtSeconds: RESET_SECONDS, eventId: "evt-five-hour" }),
          rejection({ resetsAtSeconds: RESET_SECONDS * 5, eventId: "evt-seven-day" }),
        ],
        initialModel: readModel([busyThread()]),
      });

      yield* Effect.gen(function* () {
        yield* settleUntil(
          harness.store.listPending.pipe(
            Effect.map((pending) => pending[0]?.resumeAtMs === RESET_SECONDS * 5 * 1000 + 60_000),
          ),
          "the later window to supersede the earlier arm",
        );

        expect(yield* harness.store.listPending).toHaveLength(1);
        expect(appendedActivityKinds(yield* Ref.get(harness.dispatched))).toContain(
          "coil.auto-resume.rescheduled",
        );
      }).pipe(Effect.provide(AutoResumeReactorLive.pipe(Layer.provideMerge(harness.deps))));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );
});
