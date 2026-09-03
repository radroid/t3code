/**
 * Fork-side record of the questions the runtime raised, and how they really ended.
 *
 * Upstream #5127 made session teardown settle every pending user-input as an **empty
 * answer** so the thread can settle. The tool call is denied, the session tears down, and
 * `hasPendingUserInput` reads false afterwards — so a question nobody ever saw is
 * indistinguishable from an answered one. The console cannot derive its blocking list from
 * the projection alone; this is the record that makes `voided` visible.
 *
 * It also carries the **dialog kind**. Upstream #8144 added a second blocking dialog
 * (`resume_return`) that routes through the same `AskUserQuestion` path and fires on session
 * *resume* — so a check-in landing on a torn-down session can park the loop on a dialog the
 * loop itself caused. With the kind recorded the console can say "waiting on a session-resume
 * confirmation since 01:04" instead of showing an unexplained idle loop. The runtime event
 * does not name the kind, so it is recognised through
 * `isClaudeResumeCompactionQuestion` — the same predicate the web client already uses to
 * recognise this dialog, rather than a fork-defined copy of the copy.
 *
 * ## Only armed threads accrue records
 *
 * `recordUserInput` appends, `coil-loop.json` is rewritten atomically on every mutation, and
 * `AskUserQuestion` fires on threads that will never be supervised. Recording every question
 * on the machine would grow one shared file without bound for no reader. Requests are
 * therefore recorded only while the thread is armed. Resolutions are applied unconditionally
 * — `resolveUserInput` is a no-op when nothing matches, so it cannot create a record — which
 * is what keeps a question raised under supervision resolvable after the loop stands down.
 *
 * Exported as a plain `Effect` rather than a layer: the loop reactor forks it into its own
 * fiber set beside the tick, the same way `autoResume/Reactor.ts` forks its detection tap.
 *
 * @module coil/loop/userInputs
 */

import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { isClaudeResumeCompactionQuestion } from "@t3tools/shared/claudeCompaction";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import type { LoopReceiptEmitter } from "./receipts.ts";
import type { LoopStoreShape } from "./state.ts";

/** The upstream #8144 dialog, recorded as itself so the console can name it. */
const RESUME_DIALOG_KIND = "resume_return";

/** No listener. The reactor always passes its own emitter; unit callers do not care. */
const SILENT: LoopReceiptEmitter = { enabled: false, emit: () => Effect.void };

const onRequested = (
  store: LoopStoreShape,
  event: Extract<ProviderRuntimeEvent, { readonly type: "user-input.requested" }>,
  receipts: LoopReceiptEmitter,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const requestId = event.requestId;
    // Unkeyed requests could never be resolved, so recording one would leave a question
    // that reads as pending forever.
    if (requestId === undefined) return;
    const record = yield* store.getThread(event.threadId);
    if (!record.armed) return;

    const questions = event.payload.questions;
    // The stream is hot, so "now" is the moment it was raised to within a tick — and it
    // avoids re-deriving an instant from the event's ISO string.
    const raisedAtMs = yield* Clock.currentTimeMillis;
    yield* store.recordUserInput(event.threadId, {
      requestId,
      raisedAtMs,
      dialogKind: questions.some((question) => isClaudeResumeCompactionQuestion(question.question))
        ? RESUME_DIALOG_KIND
        : null,
      // Header text for the console. A multi-question ask is rare and the first question is
      // what the dialog leads with.
      question: questions.find((question) => question.question.trim().length > 0)?.question ?? "",
      resolution: null,
      resolvedAtMs: null,
    });
    yield* receipts.emit({ type: "userInput.recorded", threadId: event.threadId, requestId });
  });

const onResolved = (
  store: LoopStoreShape,
  event: Extract<ProviderRuntimeEvent, { readonly type: "user-input.resolved" }>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const requestId = event.requestId;
    if (requestId === undefined) return;
    // The whole point of the record: teardown and an interrupted turn both settle with `{}`,
    // and neither is a human decision. Anything non-empty came from a person.
    const answered = Object.keys(event.payload.answers).length > 0;
    const resolvedAtMs = yield* Clock.currentTimeMillis;
    yield* store.resolveUserInput(
      event.threadId,
      requestId,
      answered ? "answered" : "voided",
      resolvedAtMs,
    );
  });

/** Exported for the reactor's tests; the stream tap below is the only production caller. */
export const recordUserInputEvent = (
  store: LoopStoreShape,
  event: ProviderRuntimeEvent,
  receipts: LoopReceiptEmitter = SILENT,
): Effect.Effect<void> => {
  if (event.type === "user-input.requested") return onRequested(store, event, receipts);
  if (event.type === "user-input.resolved") return onResolved(store, event);
  return Effect.void;
};

/**
 * Subscribes for the life of the fiber it is forked into. Never fails: a bookkeeping error
 * on one event must not tear down the subscription and silently retire the record.
 */
export const recordUserInputs = (
  store: LoopStoreShape,
  providerService: Pick<ProviderServiceShape, "streamEvents">,
  receipts: LoopReceiptEmitter = SILENT,
): Effect.Effect<void> =>
  Stream.runForEach(providerService.streamEvents, (event) =>
    recordUserInputEvent(store, event, receipts).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("coil loop: user-input recording failed", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        }),
      ),
    ),
  );
