/**
 * AutoResumeReactor — usage-limit auto-resume supervisor.
 *
 * Self-starts two scoped fibers at layer construction (no external `.start()`, so the
 * only upstream seam stays the 2 lines in server.ts):
 *
 *   1. Detection: subscribes once to `providerService.streamEvents` and, on a Claude
 *      `account.rate-limits.updated` event with `status:"rejected"`, schedules a resume
 *      at the structured `resetsAt` (+ margin), or on a backoff ladder when absent.
 *   2. Wake: every `pollMs`, fires any due resume — re-reading a fresh snapshot to
 *      re-check every guard immediately before dispatch (closing the wake race).
 *
 * Detection reads the structured rate-limit signal, NOT projection error state: a usage
 * limit does not produce a failed turn (the SDK has no rate-limit result subtype).
 *
 * @module t3x/autoResume/Reactor
 */

import type {
  OrchestrationThread,
  OrchestrationThreadActivityTone,
  ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import { CommandId, EventId, MessageId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { classifyRateLimit } from "./classifyRateLimit.ts";
import { resolveConfig, resolveResumePrompt } from "./config.ts";
import { planSchedule } from "./decide.ts";
import {
  CLAUDE_DRIVER_KIND,
  captureBaseline,
  cancelReason,
  isClaudeThread,
  threadIsGone,
} from "./guards.ts";
import { AutoResumeStore, type PendingResume } from "./state.ts";

const HOUR_MS = 60 * 60_000;
const BACKOFF_LOOKBACK_MS = 6 * HOUR_MS;
const CAP_WINDOW_MS = 24 * HOUR_MS;

const makeSupervisor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const store = yield* AutoResumeStore;
  const crypto = yield* Crypto.Crypto;
  const config = resolveConfig();

  const isoNow = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const appendActivity = (
    threadId: ThreadId,
    tone: OrchestrationThreadActivityTone,
    kind: string,
    summary: string,
  ) =>
    Effect.gen(function* () {
      const commandUuid = yield* crypto.randomUUIDv4;
      const eventUuid = yield* crypto.randomUUIDv4;
      const createdAt = yield* isoNow;
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`t3x-auto-resume-activity:${commandUuid}`),
        threadId,
        activity: {
          id: EventId.make(`t3x-auto-resume:${eventUuid}`),
          tone,
          kind,
          summary,
          payload: {},
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    }).pipe(
      // Timeline note is best-effort; never let it fail a resume.
      Effect.catchCause((cause) =>
        Effect.logDebug("t3x auto-resume: activity append failed", {
          threadId,
          kind,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const dispatchResume = (thread: OrchestrationThread, text: string) =>
    Effect.gen(function* () {
      const commandUuid = yield* crypto.randomUUIDv4;
      const messageUuid = yield* crypto.randomUUIDv4;
      const createdAt = yield* isoNow;
      // A plain user turn — byte-for-byte the path a keystroke produces. The decider
      // uses the thread's own runtimeMode/interactionMode and places no session-status
      // guard on turn starts (decider.ts:591-684). Provider respawn + `--resume` are
      // already handled by ClaudeAdapter, so no provider work is needed here.
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`t3x-auto-resume:${commandUuid}`),
        threadId: thread.id,
        message: {
          messageId: MessageId.make(`t3x-auto-resume:${messageUuid}`),
          role: "user",
          text,
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt,
      });
    });

  // --- detection ------------------------------------------------------------
  const onRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      if (event.type !== "account.rate-limits.updated") return;
      if (event.provider !== CLAUDE_DRIVER_KIND) return;

      const verdict = classifyRateLimit(event.payload.rateLimits);
      if (!verdict || !verdict.rejected) return;

      const threadId = event.threadId;
      const record = yield* store.getThread(threadId);
      const nowMs = yield* Clock.currentTimeMillis;
      const firedRecently = yield* store.countFiredSince(threadId, nowMs - BACKOFF_LOOKBACK_MS);
      const firedInCapWindow = yield* store.countFiredSince(threadId, nowMs - CAP_WINDOW_MS);

      const plan = planSchedule({
        verdict,
        hasPending: record.pending !== null,
        nowMs,
        firedRecently,
        firedInCapWindow,
        config,
      });
      // A capped-out thread stops scheduling here (and stops posting "scheduled" notes)
      // until its fires age out of the 24h window; all other skips are dedupe/no-op.
      if (plan.kind === "skip") return;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const thread = snapshot.threads.find((t) => t.id === threadId);
      if (!thread || threadIsGone(thread) || !isClaudeThread(thread)) return;

      yield* store.schedule({
        threadId,
        resumeAtMs: plan.resumeAtMs,
        reason: verdict.rateLimitType ?? "usage limit",
        scheduledAtMs: nowMs,
        baseline: captureBaseline(thread),
      });

      const waitMinutes = Math.max(0, Math.round((plan.resumeAtMs - nowMs) / 60_000));
      yield* appendActivity(
        threadId,
        "info",
        "t3x.auto-resume.scheduled",
        `Usage limit reached (${verdict.rateLimitType ?? "window"}). Auto-resume scheduled in ~${waitMinutes} min.`,
      );
    });

  // --- wake -----------------------------------------------------------------
  const fireOne = (pending: PendingResume, nowMs: number) =>
    Effect.gen(function* () {
      // Re-read a FRESH snapshot per item, immediately before the guard check + dispatch,
      // so every due thread is guarded against current state (not state captured before
      // earlier dispatches in the same tick ran).
      const snapshot = yield* snapshotQuery.getSnapshot();
      const thread = snapshot.threads.find((t) => t.id === pending.threadId);
      if (!thread) {
        yield* store.clearPending(pending.threadId);
        return;
      }

      const reason = cancelReason(thread, pending.baseline);
      if (reason) {
        yield* store.clearPending(pending.threadId);
        yield* appendActivity(
          thread.id,
          "info",
          "t3x.auto-resume.cancelled",
          `Auto-resume cancelled: ${reason}.`,
        );
        return;
      }

      const firedIn24h = yield* store.countFiredSince(pending.threadId, nowMs - CAP_WINDOW_MS);
      if (firedIn24h >= config.maxResumesPer24h) {
        yield* store.clearPending(pending.threadId);
        yield* appendActivity(
          thread.id,
          "error",
          "t3x.auto-resume.capped",
          `Auto-resume stopped after ${config.maxResumesPer24h} attempts in 24h.`,
        );
        return;
      }

      // Reserve the attempt (clears pending + records the fire) BEFORE dispatch so a
      // dispatch failure cannot tight-loop retry; a genuine re-limit re-arms via a new
      // rejection event, spaced out on the backoff ladder.
      yield* store.recordFired(pending.threadId, nowMs);

      const project = snapshot.projects.find((pr) => pr.id === thread.projectId);
      const workspaceRoot = project?.workspaceRoot ?? thread.worktreePath ?? null;
      const overridePrompt = (yield* store.getThread(pending.threadId)).overridePrompt;
      const text = yield* resolveResumePrompt({ workspaceRoot, threadOverride: overridePrompt });

      yield* appendActivity(
        thread.id,
        "info",
        "t3x.auto-resume.resumed",
        `Resuming now (attempt ${firedIn24h + 1} of ${config.maxResumesPer24h}).`,
      );
      yield* dispatchResume(thread, text).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("t3x auto-resume: resume dispatch failed", {
            threadId: pending.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    });

  const processDue = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const pending = yield* store.listPending;
    const due = pending.filter((p) => p.resumeAtMs <= nowMs);
    yield* Effect.forEach(due, (p) => fireOne(p, nowMs), { discard: true });
  });

  if (!config.enabled) {
    yield* Effect.logInfo("t3x auto-resume: disabled via T3X_AUTO_RESUME_ENABLED");
    return;
  }

  yield* Effect.forkScoped(
    Stream.runForEach(providerService.streamEvents, (event) =>
      onRuntimeEvent(event).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("t3x auto-resume: detection failed", {
            eventType: event.type,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    ),
  );

  yield* Effect.forkScoped(
    processDue.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("t3x auto-resume: wake tick failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.delay(Duration.millis(config.pollMs)),
      Effect.forever,
    ),
  );

  yield* Effect.logInfo("t3x auto-resume: supervisor started", {
    pollMs: config.pollMs,
    maxResumesPer24h: config.maxResumesPer24h,
  });
});

export const AutoResumeReactorLive = Layer.effectDiscard(makeSupervisor);
