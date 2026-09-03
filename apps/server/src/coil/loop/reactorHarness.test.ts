/**
 * The harness's own timing contract.
 *
 * `reactorHarness.ts` is test infrastructure, and normally that is not worth testing — except
 * that forty-eight scenarios read their assertions out of a simulated clock this file
 * advances, so *when* it advances that clock is a load-bearing property rather than an
 * implementation detail. It has been wrong once: a drain that nudged `TestClock` between
 * rounds made simulated time a function of how busy the machine was, and CI reported it as a
 * loop covering its wake twice and a check-in landing five simulated minutes late — real
 * scheduling leaking into the world the assertions read, which is the exact failure a
 * TestClock exists to make impossible.
 *
 * So: a test may spend as many scheduler turns as it needs, and simulated time may only move
 * where a test says it moves.
 *
 * @module coil/loop/reactorHarness.test
 */

import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import {
  advanceUntil,
  PER_POLL_TURNS,
  POLL_MS,
  settleQuiet,
  settleUntil,
} from "./reactorHarness.ts";

/**
 * Work that finishes only after `turns` real event-loop turns.
 *
 * A stand-in for the reactor's store writes, which are real filesystem I/O: the number of
 * turns they need is a fact about the machine, and nothing about it may reach the clock.
 */
const afterTurns = (turns: number, flag: Ref.Ref<boolean>) =>
  Effect.promise(async () => {
    for (let i = 0; i < turns; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }).pipe(Effect.andThen(Ref.set(flag, true)));

const scoped = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) =>
  body.pipe(Effect.scoped, Effect.provide(TestClock.layer()));

describe("reactorHarness — simulated time only moves where a test says it does", () => {
  it.effect("a drain spends scheduler turns and no simulated time", () =>
    Effect.gen(function* () {
      const flag = yield* Ref.make(false);
      // More turns than the whole poll budget buys, so the condition can only come true in
      // the drain that follows it. This is the loaded-runner case, made deterministic.
      yield* Effect.forkScoped(afterTurns(PER_POLL_TURNS * 3, flag));
      const startedAtMs = yield* Clock.currentTimeMillis;

      yield* advanceUntil(Ref.get(flag), "the slow work", 1);

      assert.isTrue(yield* Ref.get(flag), "the drain waited for the work to finish");
      assert.strictEqual(
        (yield* Clock.currentTimeMillis) - startedAtMs,
        POLL_MS,
        "exactly the one poll that was asked for — the drain added none of its own",
      );
    }).pipe(scoped),
  );

  it.effect("a condition that already holds costs nothing at all", () =>
    Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis;
      yield* advanceUntil(Effect.succeed(true), "nothing to wait for", 20);
      assert.strictEqual(yield* Clock.currentTimeMillis, startedAtMs);
    }).pipe(scoped),
  );

  it.effect("the counted polls are the whole cost, however long the drain runs", () =>
    Effect.gen(function* () {
      // A condition that answers `false` for more looks than three polls of budget can spend,
      // so it cannot be satisfied inside the counted polls and must be resolved in the drain
      // that follows them. It depends on nothing real — not I/O, not turns-per-pump — so this
      // pins the arithmetic rather than a machine's timing.
      const looksAvailable = 3 * (PER_POLL_TURNS + 1);
      const evaluations = yield* Ref.make(0);
      const condition = Ref.updateAndGet(evaluations, (n) => n + 1).pipe(
        Effect.map((n) => n > looksAvailable + 10),
      );
      const startedAtMs = yield* Clock.currentTimeMillis;

      yield* advanceUntil(condition, "the look after the budget ran out", 3);

      assert.isAbove(yield* Ref.get(evaluations), looksAvailable, "the drain is what answered it");
      // Three polls of budget, three polls of movement. A harness that borrowed a poll per
      // drain round is what carried a test past its own check-in floor and covered one wake
      // twice — and it would read 4, 5 or 8 here depending on how busy the machine was.
      assert.strictEqual((yield* Clock.currentTimeMillis) - startedAtMs, 3 * POLL_MS);
    }).pipe(scoped),
  );

  it.effect("even giving up costs no simulated time", () =>
    Effect.gen(function* () {
      // The discriminating case, and the one CI actually hit. A condition the drain cannot
      // satisfy is where a clock-nudging drain shows itself: it keeps buying simulated
      // minutes hoping the next tick answers, and by the time it gives up — or worse,
      // succeeds — the clock is somewhere the test never asked for. The loop had then already
      // been carried over its check-in floor, and the run it was watching was covered twice.
      const startedAtMs = yield* Clock.currentTimeMillis;
      const exit = yield* Effect.exit(
        advanceUntil(Effect.succeed(false), "something that never happens", 2),
      );

      assert.isTrue(Exit.isFailure(exit), "an unsatisfiable condition still fails the test");
      assert.strictEqual(
        (yield* Clock.currentTimeMillis) - startedAtMs,
        2 * POLL_MS,
        "the two polls it was given, and not one minute more",
      );
    }).pipe(scoped),
  );

  it.effect("settleQuiet and settleUntil never touch the clock", () =>
    Effect.gen(function* () {
      const flag = yield* Ref.make(false);
      yield* Effect.forkScoped(afterTurns(30, flag));
      const startedAtMs = yield* Clock.currentTimeMillis;

      yield* settleQuiet;
      yield* settleUntil(Ref.get(flag), "the slow work");

      assert.isTrue(yield* Ref.get(flag));
      assert.strictEqual(yield* Clock.currentTimeMillis, startedAtMs);
    }).pipe(scoped),
  );
});
