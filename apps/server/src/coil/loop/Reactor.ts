/**
 * LoopReactor — the supervisor that keeps an agent thread working unattended.
 *
 * Self-starts three scoped fibers at layer construction, exactly as
 * `autoResume/Reactor.ts` does, so the only upstream seam the loops feature takes stays the
 * three lines in `ClaudeAdapter.ts`:
 *
 *   1. **tick** — every `pollMs`, list the armed loops, resolve each one's shell, project
 *      shell and done-file, hand the lot to the pure `decide`, and execute the single action
 *      it returns.
 *   2. **rate-limit tap** — subscribes to `providerService.streamEvents` and writes
 *      `rateLimitedUntilMs` durably on a rejected verdict. Necessary because auto-resume only
 *      arms when *its* per-thread switch is on: on a thread where the user turned it off a
 *      usage limit produces no pending resume, guard 9 passes, and the loop would otherwise
 *      nudge straight into a live five-hour limit.
 *   3. **user inputs** — `recordUserInputs` from `userInputs.ts`, forked here rather than
 *      given its own layer so the whole feature is one `Layer.effectDiscard`.
 *
 * Everything that *decides* lives in `decide.ts` / `guards.ts` and is pure. This file only
 * gathers facts, executes actions and writes breadcrumbs, which is why it has no branching
 * on guard order at all.
 *
 * ## Never `getSnapshot()`
 *
 * `autoResume/Reactor.ts` reads the whole projection per pass; it has an open OOM follow-up
 * for exactly that. This reactor uses `getThreadShellById` / `getProjectShellById`, and a
 * tick with nothing armed issues **zero** queries of any kind — no SQL, no filesystem.
 *
 * ## The three firing disciplines (BACKEND §5)
 *
 *  1. **Reserve before dispatch.** `store.recordCheckIn` persists before `engine.dispatch`.
 *     This is the only unbounded path in the design: a provider that cannot spawn would
 *     otherwise tight-loop. It burns budget instead — six attempts, not four hundred and
 *     eighty a night.
 *  2. **Re-read the shell after the guard block and again before dispatch.** The re-read is
 *     re-decided against the *pre-reserve* record, so the wake race closes without the
 *     reservation we just wrote voting on its own necessity.
 *  3. **Repair the keep-active pin.** The decider clears `settledOverride` for any non-null
 *     value, so a nudge silently destroys a user's keep-active pin. It is restored with
 *     `thread.unsettle` **only** when the pre-dispatch shell already carried it, so this path
 *     can never create a pin.
 *
 * @module coil/loop/Reactor
 */

import type {
  OrchestrationProjectShell,
  OrchestrationThreadActivityTone,
  OrchestrationThreadShell,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { CommandId, EventId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { classifyRateLimit } from "../autoResume/classifyRateLimit.ts";
import { AutoResumeStore } from "../autoResume/state.ts";
import { composeCheckInPrompt, resolveConfig } from "./config.ts";
import { decide, resolveWake } from "./decide.ts";
import { hasPendingCrons } from "./guards.ts";
import { readSentinel } from "./sentinel.ts";
import { LoopStore, type LoopGlobalSettings, type LoopRecord, type StopRecord } from "./state.ts";
import type {
  DisarmAction,
  FireAction,
  LoopDecisionInput,
  StandDownAction,
  StandDownReason,
  StopAction,
} from "./types.ts";
import { recordUserInputs } from "./userInputs.ts";

/**
 * The timeline vocabulary, exported so the console keys off these constants rather than
 * re-typing the strings. `kind` is an open `TrimmedNonEmptyString` on the contract and
 * `payload` is `Schema.Unknown`, so breadcrumbs cost zero contract edits.
 */
export const LOOP_ACTIVITY_KINDS = {
  checkedIn: "coil.loop.checked-in",
  skipped: "coil.loop.skipped",
  wakeLost: "coil.loop.wake-lost",
  stopped: "coil.loop.stopped",
  disarmed: "coil.loop.disarmed",
  pinRepairFailed: "coil.loop.pin-repair-failed",
} as const;

/**
 * Skip reasons worth a timeline entry.
 *
 * Deliberately not every `StandDownReason`. `not_idle` and `check_in_floor` are what a
 * *healthy* supervised thread reports on almost every tick, and appending an activity bumps
 * `updatedAt` — the very value the trigger measures. A breadcrumb on the healthy path would
 * therefore reset the loop's own idle clock, which is the self-sustaining loop edge detection
 * exists to prevent; making the common case silent removes the possibility rather than
 * bounding it. The live reason is always available from `GET /api/coil/loop`, so nothing is
 * hidden — only the *history* is limited to the reasons a human would want to see later.
 *
 * `not_armed` and `stopped` cannot occur here: `listArmed` filters on `armed`, and `stop`
 * clears it.
 */
const NOTEWORTHY_SKIPS: ReadonlySet<StandDownReason> = new Set<StandDownReason>([
  "disabled",
  "snoozed",
  "pending_approval",
  "pending_user_input",
  "pending_plan",
  "auto_resume_pending",
  "rate_limited",
  "self_pacing",
  "ceiling",
]);

/**
 * How long to stand down for a rejected verdict that carries no `resetsAt`.
 *
 * The SDK documents `resetsAt` as optional. Writing nothing would leave the loop free to
 * nudge into a live limit, which is the hole this fiber exists to close; holding forever
 * would spend the run's deadline standing down. An hour is the compromise, and it
 * self-corrects in the expensive direction only: the one nudge that follows an expired hold
 * produces a fresh rejected event, which re-extends it.
 */
const RATE_LIMIT_FALLBACK_HOLD_MS = 60 * 60_000;

/** Human-readable summary for a stop, kept in one place so the console reads one vocabulary. */
const STOP_SUMMARY: Record<StopRecord["reason"], string> = {
  done: "Loop finished: the agent signalled done.",
  spent: "Loop ended: budget or deadline exhausted.",
  stalled: "Loop stopped: two consecutive check-ins made no progress.",
  "handed-back": "Loop stopped: you took over.",
};

const makeSupervisor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const store = yield* LoopStore;
  const autoResumeStore = yield* AutoResumeStore;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const config = resolveConfig();

  /**
   * The boot-grace floor, captured once.
   *
   * Without it every armed thread fires on the first post-restart tick, because a projection
   * `updatedAt` from before the outage reads as hours of idleness. It also covers laptop
   * sleep and upstream's restart-continuation window (#9167), where a continued thread is
   * briefly `starting` with no `activeTurnId`.
   */
  const processStartedAtMs = yield* Clock.currentTimeMillis;

  const isoNow = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /**
   * Last skip reason announced per thread, so a loop standing down for the same reason
   * across ten ticks appends one activity rather than ten. In memory on purpose: a restart
   * re-announcing once is correct (the console has no other record of *why* it is quiet),
   * and persisting it would grow the record for a fact with a one-process lifetime.
   */
  const lastSkipReason = new Map<string, string>();

  // --- timeline -------------------------------------------------------------

  /**
   * Best-effort breadcrumb. A timeline failure must never abort a check-in — the nudge is
   * the product, the note about it is not.
   */
  const appendActivity = (
    threadId: string,
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
        commandId: CommandId.make(`coil-loop-activity:${commandUuid}`),
        threadId: ThreadId.make(threadId),
        activity: {
          id: EventId.make(`coil-loop:${eventUuid}`),
          tone,
          kind,
          summary,
          payload,
          turnId: null,
          createdAt,
        },
        createdAt,
      });
      return true;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("coil loop: activity append failed", {
          threadId,
          kind,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );

  // --- reads ----------------------------------------------------------------

  /**
   * One thread shell by id.
   *
   * A projection failure resolves to `null`, which `decide` reads as "the thread is gone"
   * and answers with a **disarm**. That is the wrong answer for a transient SQL error, so
   * the failure is distinguished here and the whole thread is skipped for this tick instead
   * — a tick that reads nothing is always safe, a tick that disarms on a hiccup is not.
   */
  const readShell = (threadId: string) =>
    snapshotQuery.getThreadShellById(ThreadId.make(threadId)).pipe(
      Effect.map((option) => ({ ok: true, shell: Option.getOrNull(option) }) as const),
      Effect.catch((cause) =>
        Effect.logWarning("coil loop: thread shell read failed", { threadId, cause }).pipe(
          Effect.as({ ok: false, shell: null } as const),
        ),
      ),
    );

  /** The project row, for `workspaceRoot`. Every failure mode is "no workspace root". */
  const readProjectShell = (
    shell: OrchestrationThreadShell,
  ): Effect.Effect<OrchestrationProjectShell | null> =>
    snapshotQuery.getProjectShellById(ProjectId.make(shell.projectId)).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );

  /**
   * Assemble the pure decision input.
   *
   * The two done channels arrive here side by side and `doneSignal` takes the newer of them:
   * `sentinelAtMs` is the done-file's mtime, `loopDoneAtMs` is what the `loop_done` MCP tool
   * wrote to the record. The file stays the primary contract because it works from a plain
   * terminal with no MCP at all — `enableAgentBrowserAccess` off removes the toolkit
   * entirely — so neither channel may depend on the other.
   */
  const gatherInput = (record: LoopRecord, shell: OrchestrationThreadShell, nowMs: number) =>
    Effect.gen(function* () {
      const project = yield* readProjectShell(shell);
      const sentinel = yield* readSentinel(
        fs,
        { worktreePath: shell.worktreePath, workspaceRoot: project?.workspaceRoot ?? null },
        { armedAtMs: record.armedAtMs },
      );
      const autoResume = yield* autoResumeStore.getThread(shell.id);
      return {
        nowMs,
        processStartedAtMs,
        record,
        shell,
        // `stale` still carries its mtime: `doneSignal` owns the freshness compare, so the
        // reactor never re-implements it and the two can never disagree.
        sentinelAtMs: sentinel.kind === "absent" ? null : sentinel.mtimeMs,
        loopDoneAtMs: record.loopDoneAtMs,
        autoResumePending: autoResume.pending !== null,
        config,
        workspaceRoot: project?.workspaceRoot ?? null,
      };
    });

  // --- actions --------------------------------------------------------------

  const onStandDown = (threadId: string, action: StandDownAction) =>
    Effect.gen(function* () {
      if (!NOTEWORTHY_SKIPS.has(action.reason)) {
        // Still an edge: leaving a noteworthy reason for a quiet one must let the next
        // occurrence of the noteworthy reason announce itself again.
        lastSkipReason.delete(threadId);
        return;
      }
      if (lastSkipReason.get(threadId) === action.reason) return;
      lastSkipReason.set(threadId, action.reason);
      yield* appendActivity(
        threadId,
        "info",
        LOOP_ACTIVITY_KINDS.skipped,
        `Loop standing by: ${action.reason.replaceAll("_", " ")}.`,
        action.untilMs === null
          ? { reason: action.reason }
          : { reason: action.reason, until: action.untilMs },
      );
    });

  /**
   * Remove the pin, but only one this feature created.
   *
   * `pinnedByLoop` is cleared only when the unpin actually landed, so a failed dispatch
   * leaves the loop still responsible for a pin it made rather than orphaning it.
   */
  const unpinIfOurs = (threadId: string, record: LoopRecord) =>
    Effect.gen(function* () {
      if (!record.pinnedByLoop) return;
      const uuid = yield* crypto.randomUUIDv4;
      const unpinned = yield* engine
        .dispatch({
          type: "thread.unpin",
          commandId: CommandId.make(`coil-loop-unpin:${uuid}`),
          threadId: ThreadId.make(threadId),
        })
        .pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("coil loop: unpin failed", {
              threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
          ),
        );
      if (unpinned) {
        yield* store.update(threadId, (current) => ({ ...current, pinnedByLoop: false }));
      }
    });

  /**
   * End the provider session.
   *
   * A bound that cannot stop the agent is not a bound: T3 has no write handle on the binary's
   * cron table, so the only way to stop a self-paced run walking through its own deadline is
   * to end the session the crons live in. Blunt on purpose — it takes any live background
   * work in that session with it — and reached only where `decide` (or `hasPendingCrons` on
   * the disarm path) says wakes are still pending.
   */
  const stopProviderSession = (threadId: string) =>
    providerService.stopSession({ threadId: ThreadId.make(threadId) }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("coil loop: stopSession failed", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const onStop = (threadId: string, record: LoopRecord, action: StopAction, nowMs: number) =>
    Effect.gen(function* () {
      // `loop_done(reason)` is the one channel that carries the agent's own words. The
      // decision table never sees them — it is pure and takes a timestamp — so they are
      // stitched on here, where the terminal is actually written and read.
      const spoken = action.cause === "loop_done" ? record.loopDoneReason?.trim() : null;
      const detail = spoken ? `${action.detail}: ${spoken}` : action.detail;
      yield* store.stop(threadId, { reason: action.outcome, atMs: nowMs, detail });
      lastSkipReason.delete(threadId);
      yield* unpinIfOurs(threadId, record);
      if (action.stopSession) yield* stopProviderSession(threadId);
      yield* appendActivity(
        threadId,
        // `spent` is a normal ending, not a fault — zinc, never red, and never `done`.
        action.outcome === "stalled" ? "error" : "info",
        LOOP_ACTIVITY_KINDS.stopped,
        STOP_SUMMARY[action.outcome],
        {
          reason: action.outcome,
          cause: action.cause,
          detail,
          checkInsUsed: record.checkInsUsed,
          of: record.maxCheckIns,
        },
      );
    });

  const onDisarm = (threadId: string, record: LoopRecord, action: DisarmAction, nowMs: number) =>
    Effect.gen(function* () {
      yield* store.disarm(threadId);
      lastSkipReason.delete(threadId);
      yield* unpinIfOurs(threadId, record);
      // The thread is gone or archived but its session may still hold scheduled wakes, and
      // nothing left will ever bound them.
      if (hasPendingCrons(record, nowMs)) yield* stopProviderSession(threadId);
      yield* appendActivity(
        threadId,
        "info",
        LOOP_ACTIVITY_KINDS.disarmed,
        `Loop disarmed: ${action.reason.replaceAll("_", " ")}.`,
        { reason: action.reason },
      );
    });

  /**
   * The nudge.
   *
   * Byte-for-byte the shape a keystroke produces, with `runtimeMode` and `interactionMode`
   * **copied from the shell** rather than defaulted — a loop turn that silently downgraded a
   * thread's runtime mode would be a security regression, not a cosmetic one.
   */
  const dispatchCheckIn = (shell: OrchestrationThreadShell, text: string, createdAt: string) =>
    Effect.gen(function* () {
      const commandUuid = yield* crypto.randomUUIDv4;
      const messageUuid = yield* crypto.randomUUIDv4;
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`coil-loop:${commandUuid}`),
        threadId: shell.id,
        message: {
          messageId: MessageId.make(`coil-loop:${messageUuid}`),
          role: "user",
          text,
          attachments: [],
        },
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        createdAt,
      });
    });

  /**
   * Restore the keep-active pin the decider just cleared.
   *
   * Issued only when the pre-dispatch shell carried `settledOverride === "active"`, so it can
   * never create a pin the user did not have. A failure here logs **and** posts an
   * error-tone breadcrumb: the user asked for this thread to stay in the active list, and a
   * silent loss of that is exactly the class of bug this fork keeps paying for.
   */
  const repairPin = (threadId: string) =>
    Effect.gen(function* () {
      const uuid = yield* crypto.randomUUIDv4;
      yield* engine.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make(`coil-loop-unsettle:${uuid}`),
        threadId: ThreadId.make(threadId),
        reason: "user",
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("coil loop: keep-active pin repair failed", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(
          Effect.andThen(
            appendActivity(
              threadId,
              "error",
              LOOP_ACTIVITY_KINDS.pinRepairFailed,
              "Could not restore this thread's keep-active pin after the loop check-in.",
              { cause: Cause.pretty(cause) },
            ),
          ),
        ),
      ),
    );

  /**
   * Fire a check-in, in the order the three disciplines require.
   *
   * Reserve, then re-read, then dispatch. The re-read is re-decided against the **pre-reserve**
   * record so the reservation we just wrote cannot vote on its own necessity — decided against
   * the post-reserve record, guard 11's check-in floor would abort every single fire.
   */
  const onFire = (
    input: LoopDecisionInput & {
      readonly shell: OrchestrationThreadShell;
      readonly workspaceRoot: string | null;
    },
    action: FireAction,
  ) =>
    Effect.gen(function* () {
      const threadId = input.shell.id;
      const record = input.record;
      const createdAtIso = yield* isoNow;

      // 1. RESERVE. Before anything that can fail, so a provider that cannot spawn burns
      //    budget instead of tight-looping.
      const reserved = yield* store.recordCheckIn({
        threadId,
        firedAtMs: input.nowMs,
        createdAtIso,
        // Where the thread stood when we nudged. `updatedAt` is the cursor the ledger slices
        // activities between later, and it is the same value the trigger measured.
        activityCursor: input.shell.updatedAt,
      });
      // Carry the strike projection and settle the *previous* row's verdict. Keyed on `n`
      // rather than an index, so the ledger's 20-row cap cannot shift it onto a stranger.
      yield* store.update(threadId, (current) => ({
        ...current,
        strikes: action.checkIn.strikes,
        checkIns: current.checkIns.map((row) =>
          row.n === reserved.n - 1 ? { ...row, outcome: action.checkIn.previousOutcome } : row,
        ),
      }));
      lastSkipReason.delete(threadId);

      // 2. RE-READ, and re-decide. Guard 2 comes back with a fresh `global` here too, so the
      //    master toggle is never one tick stale at the moment money is spent.
      const fresh = yield* readShell(threadId);
      const global = yield* store.getGlobal;
      const verdict =
        fresh.shell === null
          ? null
          : decide({ ...input, record, global, shell: fresh.shell, nowMs: input.nowMs });
      if (fresh.shell === null || verdict?.type !== "fire") {
        // The reservation stands. It is spent, and that is the discipline: an abort needs
        // the thread to have moved inside one tick, which resets the idle clock, so this can
        // never repeat tightly — and refunding here would make "reserve before dispatch"
        // conditional on a judgement the fast path cannot make.
        yield* appendActivity(
          threadId,
          "info",
          LOOP_ACTIVITY_KINDS.skipped,
          "Loop check-in aborted: the thread moved before the nudge was sent.",
          {
            reason: "aborted_pre_dispatch",
            verdict: verdict === null ? "thread_gone" : verdict.type,
            n: reserved.n,
          },
        );
        return;
      }

      // 3. COMPOSE. Banked answers are marked delivered only after the dispatch, and only
      //    the ids actually included, so an answer that landed mid-composition is not lost.
      const banked = yield* store.listUndeliveredAnswers(threadId);
      const prompt = yield* composeCheckInPrompt({
        worktreePath: fresh.shell.worktreePath,
        workspaceRoot: input.workspaceRoot,
        overridePrompt: record.overridePrompt,
        checkInNumber: reserved.n,
        maxCheckIns: record.maxCheckIns,
        deadlineAtMs: record.deadlineAtMs,
        nowMs: input.nowMs,
        goal: record.goal,
        bankedAnswers: banked.map((entry) => ({
          id: entry.id,
          question: entry.question,
          answer: entry.answer ?? "",
        })),
      });

      // 4. DISPATCH. `createdAtIso` is the same string `lastCheckIn` recorded, which is what
      //    makes the handback compare exact: the decider stamps the user message with the
      //    command's `createdAt`, so our own nudge can never read as a takeover.
      const sent = yield* dispatchCheckIn(fresh.shell, prompt.text, createdAtIso).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("coil loop: check-in dispatch failed", {
            threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );
      if (!sent) return;

      yield* store.markBlockersDelivered(threadId, prompt.deliveredBlockerIds);

      // 5. REPAIR, only when the pin was already there.
      if (fresh.shell.settledOverride === "active") yield* repairPin(threadId);

      // 6. BREADCRUMBS. A lost wake is the strongest signal in the design, so it gets its own
      //    row with the numbers needed to re-diagnose it.
      if (action.degrade === "wake_lost") {
        const wake = resolveWake(input);
        // One field carries both degraded states; `gate_off` is the more actionable of the
        // two (with the gate off no wake can ever fire) so it is never clobbered.
        if (record.degraded === null) yield* store.setDegraded(threadId, "wake_lost");
        yield* appendActivity(
          threadId,
          "error",
          LOOP_ACTIVITY_KINDS.wakeLost,
          "A scheduled wake never landed. T3 covered it.",
          wake === null
            ? { cronId: null }
            : { cronId: wake.cronId, expectedAtMs: wake.atMs, graceMs: wake.graceMs },
        );
      }
      yield* appendActivity(
        threadId,
        "info",
        LOOP_ACTIVITY_KINDS.checkedIn,
        `Loop check-in ${reserved.n} of ${record.maxCheckIns}.`,
        { n: reserved.n, of: record.maxCheckIns, firedAtMs: input.nowMs, source: prompt.source },
      );
    });

  // --- the tick -------------------------------------------------------------

  const evaluateOne = (
    entry: { readonly threadId: string; readonly record: LoopRecord },
    global: LoopGlobalSettings,
    armedCount: number,
    nowMs: number,
  ) =>
    Effect.gen(function* () {
      const { threadId, record } = entry;
      const lookup = yield* readShell(threadId);
      if (!lookup.ok) return;
      if (lookup.shell === null) {
        // No shell and no read error: the thread really is gone. `decide` answers disarm.
        const action = decide({
          nowMs,
          processStartedAtMs,
          record,
          global,
          shell: null,
          sentinelAtMs: null,
          loopDoneAtMs: record.loopDoneAtMs,
          autoResumePending: false,
          armedCount,
          config,
        });
        if (action.type === "disarm") yield* onDisarm(threadId, record, action, nowMs);
        return;
      }

      const gathered = yield* gatherInput(record, lookup.shell, nowMs);
      const input = { ...gathered, global, armedCount };
      const action = decide(input);
      switch (action.type) {
        case "stand_down":
          return yield* onStandDown(threadId, action);
        case "stop":
          return yield* onStop(threadId, record, action, nowMs);
        case "disarm":
          return yield* onDisarm(threadId, record, action, nowMs);
        case "fire":
          return yield* onFire(input, action);
      }
    }).pipe(
      // Per thread, so one thread's defect cannot stop the others in the same pass — the
      // supervisor is a shared resource and a single bad record must not retire it.
      Effect.catchCause((cause) =>
        Effect.logWarning("coil loop: thread evaluation failed", {
          threadId: entry.threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const tick = Effect.gen(function* () {
    const armed = yield* store.listArmed;
    // Zero SQL and zero filesystem work when nothing is armed. This is the whole reason the
    // by-id reads replaced `getSnapshot()`.
    if (armed.length === 0) return;
    const global = yield* store.getGlobal;
    const nowMs = yield* Clock.currentTimeMillis;
    yield* Effect.forEach(armed, (entry) => evaluateOne(entry, global, armed.length, nowMs), {
      discard: true,
    });
  });

  // --- the rate-limit tap ---------------------------------------------------

  const onRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      if (event.type !== "account.rate-limits.updated") return;
      // No provider gate: `classifyRateLimit` refuses anything that is not a recognisable
      // rate-limit info object, which is the real discriminator, and any adapter forwarding
      // that shape is reporting a genuine account limit.
      const verdict = classifyRateLimit(event.payload.rateLimits);
      if (!verdict?.rejected) return;

      // Only armed threads accrue a record. `coil-loop.json` is rewritten atomically on every
      // mutation and rate limits land on threads that will never be supervised; recording
      // them all would grow one shared file without bound for no reader. Same rule as
      // `userInputs.ts`.
      const record = yield* store.getThread(event.threadId);
      if (!record.armed) return;

      const nowMs = yield* Clock.currentTimeMillis;
      const untilMs = verdict.resetsAtMs ?? nowMs + RATE_LIMIT_FALLBACK_HOLD_MS;
      // The longer of the two wins. Two limits can be live at once (a five-hour and a
      // seven-day), and holding is a non-consuming skip: over-holding costs deference time,
      // under-holding burns a check-in against a wall.
      yield* store.setRateLimitedUntil(
        event.threadId,
        Math.max(record.rateLimitedUntilMs, untilMs),
      );
    });

  // --- lifecycle ------------------------------------------------------------

  if (!config.enabled) {
    yield* Effect.logInfo("coil loop: disabled via COIL_LOOP_ENABLED");
    return;
  }

  yield* Effect.forkScoped(
    Stream.runForEach(providerService.streamEvents, (event) =>
      onRuntimeEvent(event).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("coil loop: rate-limit tap failed", {
            eventType: event.type,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    ),
  );

  yield* Effect.forkScoped(recordUserInputs(store, providerService));

  yield* Effect.forkScoped(
    Effect.gen(function* () {
      // Sleep FIRST. The projection still shows crashed turns as running until the
      // `reconcile.interrupted-turns` startup phase runs, and `processStartedAtMs` only
      // floors the idle clock — it does not stop the first pass reading a half-built world.
      yield* Effect.sleep(Duration.millis(config.pollMs));
      return yield* Effect.gen(function* () {
        yield* tick;
        yield* Effect.sleep(Duration.millis(config.pollMs));
      }).pipe(
        // Inside the loop, so a defect in one pass cannot kill the only tick fiber and
        // silently retire supervision for every thread on the machine.
        Effect.catchCause((cause) =>
          Effect.logWarning("coil loop: tick failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.forever,
      );
    }),
  );

  yield* Effect.logInfo("coil loop: supervisor started", {
    pollMs: config.pollMs,
    processStartedAtMs,
  });
});

export const LoopReactorLive = Layer.effectDiscard(makeSupervisor);
