/**
 * AutoResumeReactor — usage-limit auto-resume supervisor.
 *
 * Self-starts two scoped fibers at layer construction (no external `.start()`, so the
 * only upstream seam stays the 2 lines in server.ts):
 *
 *   1. Detection: subscribes once to `providerService.streamEvents` and, on a Claude
 *      `account.rate-limits.updated` event with `status:"rejected"`, schedules a resume
 *      at the structured `resetsAt` (+ margin), or on a backoff ladder when absent.
 *   2. Wake: sleeps until the earliest armed resume comes due (capped at `pollMs`) and
 *      fires it — re-reading a fresh snapshot to re-check every guard immediately before
 *      dispatch (closing the wake race).
 *
 * Detection reads the structured rate-limit signal, NOT projection error state: a usage
 * limit does not produce a failed turn (the SDK has no rate-limit result subtype).
 *
 * @module coil/autoResume/Reactor
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
/** Floor on the wake sleep, so an arm due in a millisecond cannot spin the fiber. */
const MIN_WAKE_MS = 250;

const makeSupervisor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const store = yield* AutoResumeStore;
  const crypto = yield* Crypto.Crypto;
  const config = resolveConfig();

  const isoNow = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /**
   * `payload` is free-form on the contract and is the only machine-readable trace this
   * feature leaves. All three silent failures (#6, #39, 2026-08-18) had to be diagnosed
   * by hand from SQL because the reason lived only in prose inside `summary`; anything
   * that wants to aggregate or alert on cancellations needs it as a field.
   */
  const appendActivity = (
    threadId: ThreadId,
    tone: OrchestrationThreadActivityTone,
    kind: string,
    summary: string,
    payload: Record<string, unknown> = {},
  ) =>
    Effect.gen(function* () {
      const commandUuid = yield* crypto.randomUUIDv4;
      const eventUuid = yield* crypto.randomUUIDv4;
      const createdAt = yield* isoNow;
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`coil-auto-resume-activity:${commandUuid}`),
        threadId,
        activity: {
          id: EventId.make(`coil-auto-resume:${eventUuid}`),
          tone,
          kind,
          summary,
          payload,
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    }).pipe(
      // Timeline note is best-effort; never let it fail a resume.
      Effect.catchCause((cause) =>
        Effect.logDebug("coil auto-resume: activity append failed", {
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
        commandId: CommandId.make(`coil-auto-resume:${commandUuid}`),
        threadId: thread.id,
        message: {
          messageId: MessageId.make(`coil-auto-resume:${messageUuid}`),
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
      // Per-thread switch. A thread the user turned off never schedules, and posts no
      // timeline note: they disabled it deliberately, so an activity row would be noise.
      if (!record.enabled) return;
      const nowMs = yield* Clock.currentTimeMillis;
      const firedRecently = yield* store.countFiredSince(threadId, nowMs - BACKOFF_LOOKBACK_MS);
      const firedInCapWindow = yield* store.countFiredSince(threadId, nowMs - CAP_WINDOW_MS);

      const plan = planSchedule({
        verdict,
        pendingResumeAtMs: record.pending?.resumeAtMs ?? null,
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

      // Replacing an existing arm (a later window superseded it — see decide.ts). The
      // fresh `captureBaseline` below is what re-baselines the resume onto whatever the
      // thread looks like now, so a supersede is also the re-arm path for #39.
      const superseded = record.pending !== null;

      yield* store.schedule({
        threadId,
        resumeAtMs: plan.resumeAtMs,
        reason: verdict.rateLimitType ?? "usage limit",
        scheduledAtMs: nowMs,
        baseline: captureBaseline(thread),
      });

      const waitMinutes = Math.max(0, Math.round((plan.resumeAtMs - nowMs) / 60_000));
      const limitType = verdict.rateLimitType ?? "window";
      yield* appendActivity(
        threadId,
        "info",
        superseded ? "coil.auto-resume.rescheduled" : "coil.auto-resume.scheduled",
        superseded
          ? `Usage limit window pushed back (${limitType}). Auto-resume rescheduled to ~${waitMinutes} min from now.`
          : `Usage limit reached (${limitType}). Auto-resume scheduled in ~${waitMinutes} min.`,
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

      // The user can switch a thread off *after* its resume was scheduled, so re-read the
      // record here rather than trusting the value seen at scheduling time, and treat a
      // disabled thread as a cancellation (drop the pending resume, say so once).
      const record = yield* store.getThread(pending.threadId);
      if (!record.enabled) {
        yield* store.clearPending(pending.threadId);
        yield* appendActivity(
          thread.id,
          "info",
          "coil.auto-resume.cancelled",
          "Auto-resume cancelled: turned off for this thread.",
        );
        return;
      }

      // `pending` structurally satisfies `ResumeArm` (baseline + resumeAtMs). The guard
      // needs to know WHICH window it was waiting on: a turn that ended before that
      // window reopened was rejected by the same limit and is not advancement.
      const reason = cancelReason(thread, pending);
      if (reason) {
        yield* store.clearPending(pending.threadId);
        yield* appendActivity(
          thread.id,
          "info",
          "coil.auto-resume.cancelled",
          `Auto-resume cancelled: ${reason}.`,
          // Enough to re-diagnose a lost arm without opening the projection: which rule
          // fired, which window it was waiting on, and which turn it was comparing.
          {
            reason,
            resumeAtMs: pending.resumeAtMs,
            baselineTurnId: pending.baseline.latestTurnId,
            observedTurnId: thread.latestTurn?.turnId ?? null,
            observedTurnCompletedAt: thread.latestTurn?.completedAt ?? null,
          },
        );
        return;
      }

      const firedIn24h = yield* store.countFiredSince(pending.threadId, nowMs - CAP_WINDOW_MS);
      if (firedIn24h >= config.maxResumesPer24h) {
        yield* store.clearPending(pending.threadId);
        yield* appendActivity(
          thread.id,
          "error",
          "coil.auto-resume.capped",
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
        "coil.auto-resume.resumed",
        `Resuming now (attempt ${firedIn24h + 1} of ${config.maxResumesPer24h}).`,
      );
      yield* dispatchResume(thread, text).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("coil auto-resume: resume dispatch failed", {
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

  /**
   * How long to sleep before looking again: until the earliest armed resume comes due,
   * capped at `pollMs` so a resume armed *during* the sleep is still picked up within one
   * poll, and floored so a near-instant due time cannot spin the fiber.
   *
   * A fixed `pollMs` cadence is unaligned to the due time, which cost the observed 0-30s
   * of lateness (an arm due at 19:51:00 fired at 19:51:42). Sleeping to the due time makes
   * fire time track armed time instead. This changes only WHEN the loop looks, never what
   * it checks once awake — `fireOne` still takes its own fresh snapshot per item, which is
   * what closes the wake race.
   *
   * Arms that are already due are excluded (`delta > 0`), so a due-but-unfired arm cannot
   * compute a zero sleep and busy-loop a full `getSnapshot()` per iteration. That is the
   * reachable failure mode here: if `processDue` dies (a snapshot read that throws), the
   * arm stays pending and stays due, and the caller above only logs.
   */
  const nextWakeMs = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const upcoming = (yield* store.listPending)
      .map((p) => p.resumeAtMs - nowMs)
      .filter((delta) => delta > 0);
    if (upcoming.length === 0) return config.pollMs;
    return Math.max(MIN_WAKE_MS, Math.min(config.pollMs, ...upcoming));
  });

  if (!config.enabled) {
    yield* Effect.logInfo("coil auto-resume: disabled via T3X_AUTO_RESUME_ENABLED");
    return;
  }

  yield* Effect.forkScoped(
    Stream.runForEach(providerService.streamEvents, (event) =>
      onRuntimeEvent(event).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("coil auto-resume: detection failed", {
            eventType: event.type,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    ),
  );

  // Process THEN sleep, deliberately: a server that restarts holding an overdue arm fires
  // it immediately rather than up to one poll interval later.
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      // Boot grace, BEFORE the first pass.
      //
      // This fiber is forked during layer construction, but crashed turns are settled later,
      // in the `reconcile.interrupted-turns` startup phase (serverRuntimeStartup.ts:359).
      // A server killed mid-turn therefore comes back with the projection still showing that
      // turn as running. If the wake fiber looks first, an arm that fell due while the machine
      // was down reads as `progressing` and `fireOne` CLEARS it — permanently, with no retry.
      // That is the same silent-arm-loss this module exists to prevent.
      //
      // The previous `processDue.pipe(delay(pollMs), forever)` shape got this for free, because
      // `Effect.delay` ran before every pass. Sleeping until the earliest due time is a strict
      // improvement afterwards, so the grace is stated explicitly rather than re-derived from
      // the poll cadence.
      yield* Effect.sleep(Duration.millis(config.pollMs));
      return yield* Effect.gen(function* () {
        yield* processDue;
        // Sleeping until the earliest due arm (rather than a fixed cadence) is what makes the
        // fire time track the armed time; `nextWakeMs` is inside the catch so a defect here
        // cannot kill the only wake fiber and silently retire the feature.
        yield* Effect.sleep(Duration.millis(yield* nextWakeMs));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("coil auto-resume: wake tick failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.forever,
      );
    }),
  );

  yield* Effect.logInfo("coil auto-resume: supervisor started", {
    pollMs: config.pollMs,
    maxResumesPer24h: config.maxResumesPer24h,
  });
});

export const AutoResumeReactorLive = Layer.effectDiscard(makeSupervisor);
