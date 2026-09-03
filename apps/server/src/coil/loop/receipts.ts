/**
 * The loop supervisor's receipts.
 *
 * The reactor's milestones are all asynchronous and most of them end in real filesystem I/O,
 * so a test that wants to assert about one has two choices: infer it from a store read after
 * spinning the scheduler, or be told. Inference is what this fork kept paying for — CI failed
 * three times on `Reactor.test.ts` and `integration.test.ts` with three different sets of
 * tests, every one of them a wait that ran out of turns on a two-core runner rather than a
 * defect in the product. AGENTS.md is explicit about the remedy: wait on receipts and worker
 * drains, never on sleeps or polling.
 *
 * So the reactor announces. Every milestone a test currently infers is published here, and
 * the harness waits on the announcement instead of guessing how many scheduler turns it
 * should take.
 *
 * ## Nothing is paid for in production
 *
 * The service is **optional**. `receiptEmitter` resolves it with `Effect.serviceOption`, and
 * when nobody has provided it — which is every production layer graph, since `CoilLayerLive`
 * does not mention this module — `emit` is a constant `Effect.void` and `enabled` is false.
 * The reactor uses `enabled` to skip even building a receipt whose fields would cost a read
 * (`tick.completed` would otherwise read the clock on the empty-armed path, which is the one
 * path that currently issues no queries of any kind).
 *
 * The buffer is bounded and **dropping**: a subscriber that stops draining loses receipts
 * rather than blocking the tick. A supervisor that stalls because a test stopped listening
 * would be a worse bug than the flake this replaces.
 *
 * @module coil/loop/receipts
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";

import type { StopRecord } from "./state.ts";

/**
 * One announced milestone.
 *
 * Every variant names something a test used to infer. `tick.completed` is the important one:
 * it is published at the **end** of every tick, including the early exit when nothing is
 * armed, so "advance one poll and let the reactor finish" is a single exact await rather than
 * a budget of scheduler turns.
 */
export type LoopReactorReceipt =
  /** The Claude adapter's route to the store is open. Published once, at layer construction. */
  | { readonly type: "hooks.installed" }
  /** A whole tick is over: every armed thread evaluated, every write durable. */
  | { readonly type: "tick.completed"; readonly armedCount: number; readonly nowMs: number }
  /** Budget spent, before anything that can fail. */
  | { readonly type: "checkIn.reserved"; readonly threadId: string; readonly n: number }
  /** The nudge landed in the engine. */
  | { readonly type: "checkIn.dispatched"; readonly threadId: string }
  /** The nudge did not go out; `reason` is the verdict that stopped it. */
  | { readonly type: "checkIn.aborted"; readonly threadId: string; readonly reason: string }
  /** Banked answers marked delivered, after the dispatch that carried them. */
  | {
      readonly type: "blockers.delivered";
      readonly threadId: string;
      readonly ids: ReadonlyArray<string>;
    }
  /** A run reached a terminal state. */
  | {
      readonly type: "stopped";
      readonly threadId: string;
      readonly outcome: StopRecord["reason"];
    }
  /** A record was disarmed without a terminal state (the thread went away). */
  | { readonly type: "disarmed"; readonly threadId: string }
  /** A stop the console banked was cleared and the session ended. */
  | { readonly type: "stopRequest.serviced"; readonly threadId: string }
  /** The rate-limit tap wrote a hold. */
  | { readonly type: "rateLimit.recorded"; readonly threadId: string; readonly untilMs: number }
  /** A question the runtime raised was recorded against an armed thread. */
  | { readonly type: "userInput.recorded"; readonly threadId: string; readonly requestId: string };

export interface LoopReactorReceiptsShape {
  readonly publish: (receipt: LoopReactorReceipt) => Effect.Effect<void>;
  /**
   * Everything published for the life of the service, in order.
   *
   * Subscribed at construction rather than handed out per wait, because the service is built
   * before the reactor is: the rate-limit tap can publish while the test body is still being
   * assembled, and a subscription opened later would miss it and wait forever.
   */
  readonly log: PubSub.Subscription<LoopReactorReceipt>;
}

export class LoopReactorReceipts extends Context.Service<
  LoopReactorReceipts,
  LoopReactorReceiptsShape
>()("t3/coil/loop/receipts/LoopReactorReceipts") {}

/**
 * Room for every receipt a scenario can produce without draining.
 *
 * Scenarios run at most a few hundred simulated polls and drain the tick receipt on each one,
 * so this is slack rather than a working limit — but it is a limit, because the alternative
 * is a queue that grows with a stuck subscriber.
 */
const RECEIPT_BUFFER = 4096;

export const makeLoopReactorReceipts: Effect.Effect<LoopReactorReceiptsShape, never, Scope.Scope> =
  Effect.gen(function* () {
    const pubsub = yield* PubSub.dropping<LoopReactorReceipt>(RECEIPT_BUFFER);
    const log = yield* PubSub.subscribe(pubsub);
    return {
      publish: (receipt) => PubSub.publish(pubsub, receipt).pipe(Effect.asVoid),
      log,
    };
  });

export const LoopReactorReceiptsLive = Layer.effect(LoopReactorReceipts, makeLoopReactorReceipts);

const noEmit = (_receipt: LoopReactorReceipt): Effect.Effect<void> => Effect.void;

export interface LoopReceiptEmitter {
  /** Whether anyone is listening. Lets a caller skip assembling a receipt, not just sending. */
  readonly enabled: boolean;
  readonly emit: (receipt: LoopReactorReceipt) => Effect.Effect<void>;
}

/**
 * Resolve the optional service into something the reactor can call unconditionally.
 *
 * `enabled` exists so a caller can skip *assembling* a receipt, not just publishing it: the
 * empty-armed tick has no `nowMs` to hand and reading one where nobody is listening would
 * spend a clock read on every poll of every T3 install forever.
 */
export const receiptEmitter: Effect.Effect<LoopReceiptEmitter> = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(LoopReactorReceipts);
  if (Option.isNone(service)) return { enabled: false, emit: noEmit };
  return { enabled: true, emit: service.value.publish };
});
