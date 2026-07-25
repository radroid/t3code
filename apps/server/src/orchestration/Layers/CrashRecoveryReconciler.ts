/**
 * CrashRecoveryReconciler - Boot-time reconciliation of leftover in-flight turns.
 *
 * When the desktop backend exits UNGRACEFULLY (SIGKILL / crash / OOM — no
 * SIGTERM), the Effect finalizer that a clean quit runs
 * (`ProviderService.runStopAll` -> `adapter.stopAll()` -> a session-set that
 * settles running turns to `interrupted`) never fires. In-flight turns are left
 * frozen at `projection_turns.state = "running"` with
 * `projection_thread_sessions.active_turn_id` still set, and on a later resume
 * the provider reports the cut-off turn as `cancelled`/`aborted`.
 *
 * At fresh boot NO turn is actually live (adapter session maps start empty and
 * runtime rows carry no pid/epoch), so EVERY `running` turn / non-null
 * `active_turn_id` in the read model is by definition a leftover from a previous
 * process. This module reconciles them by MIRRORING the graceful path: it
 * dispatches a `thread.session.set` command (status `stopped`, `activeTurnId`
 * null) per crashed thread — exactly what `ProviderRuntimeIngestion` dispatches
 * on `session.exited`. It never mutates projections directly (projections are a
 * pure function of the event log and would be reverted on rebuild).
 *
 * FOLLOW-UP (deliberately out of scope): this only settles turns to a resumable
 * `interrupted` state. Auto-resume RE-ARMING (a crash marker + boot producer
 * that makes the turn auto-continue) is a separate follow-up.
 *
 * @module CrashRecoveryReconciler
 */
import { CommandId, type OrchestrationSession, type OrchestrationThread } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

/**
 * A thread carries a leftover in-flight turn when the read model still reports
 * an active turn — a running latest turn, a live (`running`/`starting`) session,
 * or a non-null `activeTurnId`. At fresh boot none of these can reflect a truly
 * live turn, so each is a crash leftover to settle.
 */
export function threadHasLeftoverInFlightTurn(thread: OrchestrationThread): boolean {
  const status = thread.session?.status;
  return (
    thread.latestTurn?.state === "running" ||
    status === "running" ||
    status === "starting" ||
    (thread.session?.activeTurnId ?? null) !== null
  );
}

/**
 * Settle one crashed thread by mirroring the `session.exited` session-set:
 * force `status: "stopped"` and `activeTurnId: null` while preserving the other
 * session fields, which drives the thread-turns projection to settle the still-
 * running turn to `interrupted`. Returns 1 when a command was dispatched.
 */
const settleCrashedThread = (thread: OrchestrationThread) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;
    const now = DateTime.formatIso(yield* DateTime.now);
    const uuid = yield* crypto.randomUUIDv4;
    const existing = thread.session;

    const session: OrchestrationSession = {
      threadId: thread.id,
      status: "stopped",
      providerName: existing?.providerName ?? null,
      ...(existing?.providerInstanceId !== undefined
        ? { providerInstanceId: existing.providerInstanceId }
        : {}),
      runtimeMode: existing?.runtimeMode ?? "full-access",
      activeTurnId: null,
      lastError: existing?.lastError ?? null,
      updatedAt: now,
    };

    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`t3-crash-recovery:${uuid}`),
      threadId: thread.id,
      session,
      createdAt: now,
    });
    return 1;
  });

/**
 * Reconcile every leftover in-flight turn found in the read model at boot.
 *
 * Never fails: a snapshot read failure or a single per-thread dispatch failure
 * is logged and swallowed so one bad thread can never abort the loop or block
 * startup. Returns the number of threads actually reconciled.
 */
export const reconcileInterruptedTurnsOnBoot: Effect.Effect<
  { readonly reconciledCount: number },
  never,
  OrchestrationEngineService | ProjectionSnapshotQuery | Crypto.Crypto
> = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;

  const snapshot = yield* snapshotQuery.getSnapshot().pipe(
    Effect.catchCause((cause) =>
      Effect.logError("crash-recovery reconcile: failed to read projection snapshot", {
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(null)),
    ),
  );
  if (snapshot === null) {
    return { reconciledCount: 0 };
  }

  const candidates = snapshot.threads.filter(threadHasLeftoverInFlightTurn);

  const settledCounts = yield* Effect.forEach(
    candidates,
    (thread) =>
      settleCrashedThread(thread).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "crash-recovery reconcile: failed to settle a crashed thread; continuing",
            {
              threadId: thread.id,
              cause: Cause.pretty(cause),
            },
          ).pipe(Effect.as(0)),
        ),
      ),
    { concurrency: 1 },
  );

  const reconciledCount = settledCounts.reduce((total, count) => total + count, 0);
  if (reconciledCount > 0) {
    yield* Effect.logInfo("crash-recovery reconcile: settled leftover in-flight turns", {
      reconciledCount,
      candidateCount: candidates.length,
    });
  }
  return { reconciledCount };
});
