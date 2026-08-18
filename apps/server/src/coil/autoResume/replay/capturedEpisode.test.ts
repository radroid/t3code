// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { AutoResumeReactorLive } from "../Reactor.ts";
import type { Episode } from "./episode.ts";
import {
  appendedActivityKinds,
  dispatchedTypes,
  makeReplayHarness,
  readModel,
  rebaseRateLimitEvents,
  REPLAY_THREAD_ID,
  settleQuiet,
  settleUntil,
  threadRow,
} from "./reactorHarness.ts";

function loadFixture(name: string): Episode {
  const file = NodePath.join(import.meta.dirname, "fixtures", `${name}.json`);
  return JSON.parse(NodeFS.readFileSync(file, "utf8")) as Episode;
}

const episode = loadFixture("macos-hard-block-a");

/**
 * The reactor's input, taken from the episode's RECORDED canonical events.
 *
 * A capture stores both halves of the adapter boundary, so these are real events the real
 * adapter really emitted during a real usage-limit episode — not hand-written stand-ins.
 * That the adapter still reproduces them from the native messages is asserted separately,
 * in `adapterReplay.test.ts`; splitting it that way keeps each file in one clock domain.
 * Re-running the adapter here would need the live clock to drain an AsyncIterable while
 * these scenarios need TestClock to skip four hours, and the two cannot coexist in one test.
 */
const rateLimitEvents: ReadonlyArray<ProviderRuntimeEvent> = rebaseRateLimitEvents(
  episode.canonical
    .filter((entry) => entry.type === "account.rate-limits.updated")
    .map((entry) => entry.event as ProviderRuntimeEvent),
  Date.parse(episode.provenance.firstObservedAt),
  // Retarget at the harness's thread id; the capture's own is a real uuid.
).map((event) => ({ ...event, threadId: REPLAY_THREAD_ID }) as unknown as ProviderRuntimeEvent);

/**
 * Advance in poll-sized steps until `condition` holds.
 *
 * A single large `TestClock.adjust` does not reliably drive the wake fiber's
 * `delay + forever` loop, so time moves one poll interval at a time. The captured window is
 * ~4 hours, which at a 30s poll is several hundred steps — each costs only scheduler turns.
 */
const advanceUntil = (condition: Effect.Effect<boolean>, description: string, maxSteps = 700) =>
  Effect.gen(function* () {
    for (let step = 0; step < maxSteps; step++) {
      if (yield* condition) return;
      yield* TestClock.adjust(Duration.millis(30_000));
      yield* settleQuiet;
    }
    if (yield* condition) return;
    return yield* Effect.die(new Error(`timed out waiting for ${description}`));
  });

const pendingCountIs = (
  store: { readonly listPending: Effect.Effect<ReadonlyArray<unknown>> },
  expected: number,
) => store.listPending.pipe(Effect.map((pending) => pending.length === expected));

describe("captured macOS hard block → real reactor", () => {
  it.effect("arms a resume from a real captured rejection", () =>
    Effect.gen(function* () {
      expect(rateLimitEvents.length).toBeGreaterThan(0);

      const harness = yield* makeReplayHarness({
        events: rateLimitEvents,
        initialModel: readModel([threadRow()]),
      });

      yield* Effect.gen(function* () {
        yield* settleUntil(
          pendingCountIs(harness.store, 1),
          "a resume to be armed from the captured rejection",
        );

        const pending = yield* harness.store.listPending;
        expect(pending[0]?.threadId).toBe(REPLAY_THREAD_ID);
        // The arm must name the limit the capture carries — that string reaches the user
        // in the timeline note.
        expect(pending[0]?.reason).toBe("five_hour");

        const commands = yield* Ref.get(harness.dispatched);
        expect(appendedActivityKinds(commands)).toContain("coil.auto-resume.scheduled");
        expect(dispatchedTypes(commands)).not.toContain("thread.turn.start");
      }).pipe(Effect.provide(AutoResumeReactorLive.pipe(Layer.provideMerge(harness.deps))));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("fires the armed resume once the captured window reopens", () =>
    Effect.gen(function* () {
      const harness = yield* makeReplayHarness({
        events: rateLimitEvents,
        initialModel: readModel([threadRow()]),
      });

      yield* Effect.gen(function* () {
        yield* settleUntil(pendingCountIs(harness.store, 1), "the resume to arm");

        // The armed time is derived from the captured payload, not from a constant: reset
        // plus the configured 60s safety margin. Asserting it here is what preserves the
        // capture's fidelity even though the clock below is rebased.
        const pending = yield* harness.store.listPending;
        const resumeAtMs = pending[0]!.resumeAtMs;
        expect(resumeAtMs).toBeGreaterThan(60_000);

        yield* settleQuiet;
        expect(dispatchedTypes(yield* Ref.get(harness.dispatched))).not.toContain(
          "thread.turn.start",
        );

        yield* advanceUntil(
          Ref.get(harness.dispatched).pipe(
            Effect.map((commands) => dispatchedTypes(commands).includes("thread.turn.start")),
          ),
          "the resume to fire after the captured window reopened",
        );

        const commands = yield* Ref.get(harness.dispatched);
        expect(appendedActivityKinds(commands)).toContain("coil.auto-resume.resumed");
        expect(yield* harness.store.listPending).toHaveLength(0);
        expect(yield* harness.store.countFiredSince(REPLAY_THREAD_ID, 0)).toBe(1);
      }).pipe(Effect.provide(AutoResumeReactorLive.pipe(Layer.provideMerge(harness.deps))));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );
});
