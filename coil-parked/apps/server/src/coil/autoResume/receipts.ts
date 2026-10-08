/**
 * The auto-resume supervisor's receipts.
 *
 * Every milestone this reactor reaches is asynchronous and most end in real filesystem I/O,
 * so a test that wants to assert about one has two choices: infer it from a store read after
 * spinning the scheduler, or be told. Inference is what this file replaces — `Reactor.test.ts`
 * went red in CI (radroid/t3code#134) on `pending must be cleared: expected 1 to equal +0`,
 * which was not a defect in the product but a wait that ran out of scheduler turns on a
 * loaded runner. AGENTS.md is explicit about the remedy: wait on receipts and worker drains,
 * never on sleeps or polling.
 *
 * So the reactor announces, exactly as the loop supervisor does (`coil/loop/receipts.ts`),
 * and the tests await the announcement instead of guessing how many turns it should take.
 *
 * ## Nothing is paid for in production
 *
 * The service is **optional**. `receiptEmitter` resolves it with `Effect.serviceOption`, and
 * when nobody has provided it — which is every production layer graph, since `coil/index.ts`
 * does not mention this module — `emit` is a constant `Effect.void` and `enabled` is false.
 * Callers use `enabled` to skip even assembling a receipt.
 *
 * The buffer is bounded and **dropping**: a subscriber that stops draining loses receipts
 * rather than blocking the wake fiber. A supervisor that stalls because a test stopped
 * listening would be a worse bug than the flake this replaces.
 *
 * @module coil/autoResume/receipts
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";

/**
 * One announced milestone.
 *
 * Every variant names something a test used to infer from the store or from the recorded
 * command list. `tick.completed` is the important one: it is published at the **end** of
 * every wake pass, including the one where nothing is due, so "advance one poll and let the
 * reactor finish" is a single exact await rather than a budget of scheduler turns.
 */
export type AutoResumeReactorReceipt =
  /** A whole wake pass is over: every due arm decided, every write durable. */
  | { readonly type: "tick.completed"; readonly dueCount: number; readonly nowMs: number }
  /** Detection armed a resume. `superseded` is true when it replaced an existing arm. */
  | {
      readonly type: "resume.scheduled";
      readonly threadId: string;
      readonly resumeAtMs: number;
      readonly superseded: boolean;
    }
  /** Detection saw a rejection and armed nothing; `reason` is the gate that stopped it. */
  | { readonly type: "resume.skipped"; readonly threadId: string; readonly reason: string }
  /** An armed resume was dropped at wake time; `reason` is the guard that dropped it. */
  | { readonly type: "resume.cancelled"; readonly threadId: string; readonly reason: string }
  /** The resume turn went out (or was attempted — a failed dispatch still burns the attempt). */
  | { readonly type: "resume.fired"; readonly threadId: string; readonly attempt: number };

export interface AutoResumeReactorReceiptsShape {
  readonly publish: (receipt: AutoResumeReactorReceipt) => Effect.Effect<void>;
  /**
   * Everything published for the life of the service, in order.
   *
   * Subscribed at construction rather than handed out per wait, because the service is built
   * before the reactor is: detection can publish while the test body is still being
   * assembled, and a subscription opened later would miss it and wait forever.
   */
  readonly log: PubSub.Subscription<AutoResumeReactorReceipt>;
}

export class AutoResumeReactorReceipts extends Context.Service<
  AutoResumeReactorReceipts,
  AutoResumeReactorReceiptsShape
>()("t3/coil/autoResume/receipts/AutoResumeReactorReceipts") {}

/**
 * Room for every receipt a scenario can produce without draining.
 *
 * Scenarios run at most a few hundred simulated polls and drain the tick receipt on each one,
 * so this is slack rather than a working limit — but it is a limit, because the alternative
 * is a queue that grows with a stuck subscriber.
 */
const RECEIPT_BUFFER = 4096;

export const makeAutoResumeReactorReceipts: Effect.Effect<
  AutoResumeReactorReceiptsShape,
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const pubsub = yield* PubSub.dropping<AutoResumeReactorReceipt>(RECEIPT_BUFFER);
  const log = yield* PubSub.subscribe(pubsub);
  return {
    publish: (receipt) => PubSub.publish(pubsub, receipt).pipe(Effect.asVoid),
    log,
  };
});

export const AutoResumeReactorReceiptsLive = Layer.effect(
  AutoResumeReactorReceipts,
  makeAutoResumeReactorReceipts,
);

const noEmit = (_receipt: AutoResumeReactorReceipt): Effect.Effect<void> => Effect.void;

export interface AutoResumeReceiptEmitter {
  /** Whether anyone is listening. Lets a caller skip assembling a receipt, not just sending. */
  readonly enabled: boolean;
  readonly emit: (receipt: AutoResumeReactorReceipt) => Effect.Effect<void>;
}

/** Resolve the optional service into something the reactor can call unconditionally. */
export const receiptEmitter: Effect.Effect<AutoResumeReceiptEmitter> = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(AutoResumeReactorReceipts);
  if (Option.isNone(service)) return { enabled: false, emit: noEmit };
  return { enabled: true, emit: service.value.publish };
});
