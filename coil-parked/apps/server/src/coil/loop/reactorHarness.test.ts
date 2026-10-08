/**
 * The harness's own timing contract.
 *
 * `reactorHarness.ts` is test infrastructure, and normally that is not worth testing — except
 * that forty-eight scenarios read their assertions out of a simulated clock it advances, so
 * *when* it advances that clock is a load-bearing property rather than an implementation
 * detail. It has been wrong twice, and both times the bill arrived as assertions about the
 * product: a loop covering one wake twice, and a check-in landing five simulated minutes late,
 * on a two-core CI runner where a wait that counted scheduler turns ran out of them.
 *
 * The waits are receipts now, so the properties below are the ones that matter: a poll waits
 * for the whole tick however slow the machine is, and simulated time moves only where a
 * scenario says it moves.
 *
 * The reactor here is a stand-in that publishes the same `tick.completed` the real one does,
 * with deliberately slow work in front of it. Booting the real supervisor would test the
 * supervisor; this tests the waiting.
 *
 * @module coil/loop/reactorHarness.test
 */

import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { advancePolls, advanceUntil, POLL_MS, untilReceipt } from "./reactorHarness.ts";
import { LoopReactorReceipts, LoopReactorReceiptsLive } from "./receipts.ts";

/**
 * Work that finishes only after `turns` real event-loop turns.
 *
 * A stand-in for the reactor's store writes, which are real filesystem I/O: how many turns
 * they need is a fact about the machine, and nothing about it may reach the clock.
 */
const afterTurns = (turns: number) =>
  Effect.promise(async () => {
    for (let i = 0; i < turns; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });

/** Far more turns than any turn-counting wait would have budgeted. */
const SLOW_TURNS = 200;

/**
 * A reactor-shaped fiber: sleep a poll, do slow work, announce that the tick is over.
 *
 * `ticks` counts completed passes, so a test can assert the wait really waited rather than
 * merely returned.
 */
const fakeReactor = Effect.gen(function* () {
  const receipts = yield* LoopReactorReceipts;
  const ticks = yield* Ref.make(0);
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      yield* Effect.sleep(Duration.millis(POLL_MS));
      yield* afterTurns(SLOW_TURNS);
      const nowMs = yield* Clock.currentTimeMillis;
      yield* Ref.update(ticks, (n) => n + 1);
      yield* receipts.publish({ type: "tick.completed", armedCount: 0, nowMs });
    }).pipe(Effect.forever),
  );
  return { ticks, receipts };
});

const scoped = <A, E>(body: Effect.Effect<A, E, Scope.Scope | LoopReactorReceipts>) =>
  body.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(LoopReactorReceiptsLive, TestClock.layer())),
  );

describe("reactorHarness — a poll is one whole tick, and time moves nowhere else", () => {
  it.effect("a poll waits for the tick to finish, however slow the machine is", () =>
    Effect.gen(function* () {
      const { ticks } = yield* fakeReactor;

      yield* advancePolls(3);

      assert.strictEqual(yield* Ref.get(ticks), 3, "three ticks ran to completion");
      assert.strictEqual(
        yield* Clock.currentTimeMillis,
        3 * POLL_MS,
        "three polls of movement, and not a millisecond of the machine's own",
      );
    }).pipe(scoped),
  );

  it.effect("advanceUntil rests on the poll where the answer arrived", () =>
    Effect.gen(function* () {
      const { ticks } = yield* fakeReactor;
      // True on the fourth completed tick and no earlier, so the resting place is known.
      const condition = Ref.get(ticks).pipe(Effect.map((n) => n >= 4));

      yield* advanceUntil(condition, "the fourth tick", 20);

      assert.strictEqual(yield* Clock.currentTimeMillis, 4 * POLL_MS);
    }).pipe(scoped),
  );

  it.effect("a condition that already holds costs nothing at all", () =>
    Effect.gen(function* () {
      yield* fakeReactor;
      yield* advanceUntil(Effect.succeed(true), "nothing to wait for", 20);
      assert.strictEqual(yield* Clock.currentTimeMillis, 0);
    }).pipe(scoped),
  );

  it.effect("even giving up costs only the polls it was given", () =>
    Effect.gen(function* () {
      // The discriminating case, and the one CI hit: a wait that cannot be satisfied is where
      // a harness that buys simulated time hoping the next round answers shows itself. By the
      // time it gives up — or worse, succeeds — the clock is somewhere no test asked for, and
      // in `136c` that was past the loop's check-in floor, which covered one wake twice.
      yield* fakeReactor;
      const exit = yield* Effect.exit(
        advanceUntil(Effect.succeed(false), "something that never happens", 2),
      );

      assert.isTrue(Exit.isFailure(exit), "an unsatisfiable condition still fails the test");
      assert.strictEqual(
        yield* Clock.currentTimeMillis,
        2 * POLL_MS,
        "the two polls it was given, and not one minute more",
      );
    }).pipe(scoped),
  );

  it.effect("waiting for a receipt spends no simulated time", () =>
    Effect.gen(function* () {
      const { receipts } = yield* fakeReactor;
      yield* Effect.forkScoped(
        afterTurns(SLOW_TURNS).pipe(
          Effect.andThen(receipts.publish({ type: "disarmed", threadId: "thread-1" })),
        ),
      );

      const receipt = yield* untilReceipt((r) => r.type === "disarmed");

      assert.strictEqual(receipt.type, "disarmed");
      assert.strictEqual(yield* Clock.currentTimeMillis, 0, "the clock never moved");
    }).pipe(scoped),
  );
});
