// @effect-diagnostics globalDate:off - parses explicit ISO strings off a thread shell; the clock is read through `Clock`.
/**
 * Fork-owned raw HTTP routes backing the loop console and the loop settings panel.
 *
 *   GET  /api/coil/loop?threadId=…   -> { threadId, record, derived, blockers, ledger }
 *   POST /api/coil/loop              -> arm / rearm / edit / disarm, same shape back
 *   GET  /api/coil/loops             -> { loops: [...] }, deterministically ordered
 *   GET  /api/coil/loop/settings     -> the global block + armedCount
 *   POST /api/coil/loop/settings     -> write the master toggle and the defaults
 *   POST /api/coil/loop/answer       -> answer one deferred blocker
 *
 * Raw routes rather than WS-RPC for the reason `webPush/http.ts` states: an RPC would force
 * edits to `@t3tools/contracts`, `ws.ts` and its scope map, where a raw route costs one
 * additive line in a fork-owned file. Everything here is **operate** scope, including the
 * reads: these endpoints describe and mutate unattended scheduling, and the read scope is
 * for content.
 *
 * ## Two rules this module exists to enforce
 *
 * **Nothing is clamped.** `maxCheckIns` outside 1..20 and a deadline in the past are 400s
 * with distinct codes, never a silently corrected value. This is a feature that spends money
 * unattended overnight; a clamp turns a typo into a bill and hides it. Every validation runs
 * before the first store write, so a 400 leaves the durable record byte-identical.
 *
 * **Arming pins, and only unpins what it pinned.** `thread.pin`'s decider case emits
 * companion `thread.unsettled` and `thread.unsnoozed` events — it is a promotion, not a
 * decoration. So arming a *snoozed* thread is `400 thread_snoozed` (cancelling a human's
 * snooze is the human's decision, not a supervisor's), arming a *settled* thread is fine
 * (that is what the human asked for), and `pinnedByLoop` — recorded true only when
 * `pinnedAt` was null before the arm — gates the unpin so disarming never removes a pin the
 * user set themselves.
 *
 * @module coil/loop/http
 */

import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { AuthOrchestrationOperateScope, CommandId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { authenticateWithScope, routeAuthErrorTags } from "../http/auth.ts";
import { atArmedCeiling, hasPendingCrons } from "./guards.ts";
import {
  Blocker,
  CheckInRow,
  LoopGlobalSettings,
  LoopRecord,
  LoopStore,
  type LoopStoreShape,
} from "./state.ts";

export const LOOP_ROUTE_PATH = "/api/coil/loop";
export const LOOPS_ROUTE_PATH = "/api/coil/loops";
export const LOOP_SETTINGS_ROUTE_PATH = "/api/coil/loop/settings";
export const LOOP_ANSWER_ROUTE_PATH = "/api/coil/loop/answer";

/** The hard ceiling on a single run's check-ins. A request above it is a 400, never a clamp. */
export const MAX_CHECK_INS = 20;

/** Operate (not read) scope on every route: these describe and mutate scheduling. */
const authenticate = authenticateWithScope(AuthOrchestrationOperateScope);

// --- wire shapes ------------------------------------------------------------

/**
 * The route's reading of the state machine, from the durable record plus one thread shell.
 *
 * Deliberately *not* the reactor's verdict. The reactor owns guard order, the wake-grace
 * arithmetic and the stop sweep; this is the subset a request can state truthfully without
 * a tick, so the console can render before the next poll. Where the two could disagree —
 * a wake that is late but still inside its grace — this reports the conservative reading
 * (`self_pacing` only while the wake is still in the future) and lets the reactor decide
 * whether the wake was lost.
 */
export const LoopDerivedView = Schema.Struct({
  state: Schema.Literals([
    "off",
    "watching",
    "self_pacing",
    "standing_down",
    "held",
    "blocked",
    "stopped",
  ]),
  /** Why, when the state alone does not say: `disabled`, `rate_limited`, `pending_input`, … */
  reason: Schema.NullOr(Schema.String),
  stoppedReason: Schema.NullOr(Schema.Literals(["done", "spent", "stalled", "handed-back"])),
  checkInsUsed: Schema.Number,
  maxCheckIns: Schema.Number,
  deadlineAtMs: Schema.Number,
  msUntilDeadline: Schema.Number,
  rateLimitedUntilMs: Schema.Number,
  /** Earliest recorded wake that parsed, past or future. `null` = no deference available. */
  nextWakeAtMs: Schema.NullOr(Schema.Number),
  snoozedUntilMs: Schema.NullOr(Schema.Number),
  /** False when the thread has no shell — deleted, archived away, or never existed. */
  threadKnown: Schema.Boolean,
  globalEnabled: Schema.Boolean,
  armedCount: Schema.Number,
  maxArmedThreads: Schema.Number,
});
export type LoopDerivedView = typeof LoopDerivedView.Type;

/**
 * `blockers` and `ledger` are projections of `record`, lifted to the top level because they
 * are the console's two main sections: `blockers` is the *unanswered* subset (what is
 * actionable now), `ledger` is the iteration history.
 */
export const LoopView = Schema.Struct({
  threadId: Schema.String,
  record: LoopRecord,
  derived: LoopDerivedView,
  blockers: Schema.Array(Blocker),
  ledger: Schema.Array(CheckInRow),
});
export type LoopView = typeof LoopView.Type;

export const LoopListView = Schema.Struct({ loops: Schema.Array(LoopView) });
export type LoopListView = typeof LoopListView.Type;

export const LoopSettingsView = Schema.Struct({
  ...LoopGlobalSettings.fields,
  /** How many threads are armed right now, against `maxArmedThreads`. */
  armedCount: Schema.Number,
});
export type LoopSettingsView = typeof LoopSettingsView.Type;

const WriteBody = Schema.Struct({
  threadId: Schema.String,
  action: Schema.Literals(["arm", "rearm", "edit", "disarm", "clear"]),
  // Nullable *and* optional: `deadline_required` must be able to tell "absent" from a
  // deliberate null, and both are the same refusal.
  maxCheckIns: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  deadlineAtMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  goal: Schema.optionalKey(Schema.NullOr(Schema.String)),
  idleMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  busyIdleMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  overridePrompt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
type WriteBody = typeof WriteBody.Type;
const decodeWriteBody = Schema.decodeUnknownEffect(WriteBody);

const SettingsBody = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  maxArmedThreads: Schema.optionalKey(Schema.Number),
  defaultMaxCheckIns: Schema.optionalKey(Schema.Number),
  defaultRunMs: Schema.optionalKey(Schema.Number),
  defaultIdleMs: Schema.optionalKey(Schema.Number),
  defaultBusyIdleMs: Schema.optionalKey(Schema.Number),
});
type SettingsBody = typeof SettingsBody.Type;
const decodeSettingsBody = Schema.decodeUnknownEffect(SettingsBody);

/**
 * `POST /api/coil/loop/answer`.
 *
 * **The blocker half only, and the field is named `blockerId` rather than §9's `id`.** §9 sketched
 * one polymorphic `id` routing two mechanisms — a native pending input to
 * `thread.user-input.respond`, a deferred blocker to this store — behind a single console control.
 * The native half is not built and this route does not stand in for it: a native
 * `AskUserQuestion` is already rendered live and answerable by `ComposerPendingUserInputPanel`
 * inside the composer, so the console names it and points there rather than cloning the control.
 * That leaves upstream's answer path with exactly one instance of itself on the page, and it is
 * also the honest reading of the §9 note that this route cannot build a correct `answers` map:
 * upstream keys answers by *question* id while the phase-1 `UserInputRecord` stores one
 * `requestId` and one question string. An explicit `blockerId` says which of the two mechanisms
 * this route serves; a `requestId` field is what the native half would add if it is ever built.
 */
const AnswerBody = Schema.Struct({
  threadId: Schema.String,
  blockerId: Schema.String,
  answer: Schema.String,
});
type AnswerBody = typeof AnswerBody.Type;
const decodeAnswerBody = Schema.decodeUnknownEffect(AnswerBody);

// --- responses --------------------------------------------------------------

/**
 * Every refusal carries a machine-readable code, because the console words them
 * differently: "you must pick an end time" is a different sentence from "that end time has
 * already passed", and a bare 400 collapses them.
 */
const fail = (status: number, error: string, detail?: Record<string, unknown>) =>
  HttpServerResponse.jsonUnsafe({ error, ...detail }, { status });

/**
 * The request body as JSON, or `unknown` that will never decode.
 *
 * `request.json` *fails* on a body that is not JSON at all, and that failure is not one of
 * `routeAuthErrorTags` — so without this it escapes the handler and the client gets a bare
 * empty 400 instead of the `invalid_body` code the console words. Every refusal on these
 * routes carries a machine-readable code; a malformed body is not the exception.
 */
const readJsonBody = (request: HttpServerRequest.HttpServerRequest): Effect.Effect<unknown> =>
  request.json.pipe(Effect.orElseSucceed(() => null as unknown));

// --- derivation -------------------------------------------------------------

const parseIsoMs = (value: string | null | undefined): number | null => {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Earliest recorded wake that parsed. `null` entries mean "no deference", not "now". */
const earliestWakeMs = (record: LoopRecord): number | null => {
  let earliest: number | null = null;
  for (const entry of record.crons?.entries ?? []) {
    const next = entry.nextFireAtMs;
    if (next === null) continue;
    if (earliest === null || next < earliest) earliest = next;
  }
  return earliest;
};

const deriveView = (input: {
  readonly record: LoopRecord;
  readonly shell: OrchestrationThreadShell | null;
  readonly global: LoopGlobalSettings;
  readonly armedCount: number;
  readonly nowMs: number;
}): LoopDerivedView => {
  const { record, shell, global, nowMs } = input;
  const snoozedUntilMs = parseIsoMs(shell?.snoozedUntil ?? null);
  const nextWakeAtMs = earliestWakeMs(record);

  const base = {
    reason: null as string | null,
    stoppedReason: record.stopped?.reason ?? null,
    checkInsUsed: record.checkInsUsed,
    maxCheckIns: record.maxCheckIns,
    deadlineAtMs: record.deadlineAtMs,
    msUntilDeadline: Math.max(0, record.deadlineAtMs - nowMs),
    rateLimitedUntilMs: record.rateLimitedUntilMs,
    nextWakeAtMs,
    snoozedUntilMs,
    threadKnown: shell !== null,
    globalEnabled: global.enabled,
    armedCount: input.armedCount,
    maxArmedThreads: global.maxArmedThreads,
  };

  // Terminal first: a stop is sticky and outranks every live reading, including the master
  // toggle. Then `off`, so an unarmed thread never reports a guard's opinion of it.
  if (record.stopped !== null) {
    return { ...base, state: "stopped", reason: record.stopped.reason };
  }
  if (!record.armed) return { ...base, state: "off" };
  // Guard 2: the toggle stands loops down; it disarms and stops nothing.
  if (!global.enabled) return { ...base, state: "standing_down", reason: "disabled" };
  // `held`, matching guard 6's phase and `status.ts`: a snooze is a bounded hold with an
  // expiry, not a question waiting on an answer.
  if (snoozedUntilMs !== null && snoozedUntilMs > nowMs) {
    return { ...base, state: "held", reason: "snoozed" };
  }
  // Guard 8, including the plan clause: a thread parked on an unapproved plan is waiting on
  // a human even though `hasPendingUserInput` is false.
  if (
    shell !== null &&
    (shell.hasPendingApprovals || shell.hasPendingUserInput || shell.hasActionableProposedPlan)
  ) {
    return { ...base, state: "blocked", reason: "pending_input" };
  }
  if (nowMs < record.rateLimitedUntilMs) {
    return { ...base, state: "held", reason: "rate_limited" };
  }
  // Guard 10b, conservatively: only a wake still *ahead of us* and inside the run's deadline
  // is visible deference. A wake past due is the reactor's call, since whether it is merely
  // late or genuinely lost depends on the derived grace.
  if (nextWakeAtMs !== null && nextWakeAtMs > nowMs && nextWakeAtMs <= record.deadlineAtMs) {
    return { ...base, state: "self_pacing", reason: null };
  }
  // Guard 14, last as in the guard table, and through the guard's own predicate so the
  // console can never say "Watching" about a loop the supervisor is standing down. Without
  // it the ceiling is the one stand-down with no lens at all: the loop goes quiet and the
  // panel keeps claiming it is running.
  if (atArmedCeiling(input.armedCount, global)) {
    return { ...base, state: "standing_down", reason: "ceiling" };
  }
  return { ...base, state: "watching" };
};

// --- validation -------------------------------------------------------------

/** A finite number the caller actually sent, as opposed to absent or null. */
const provided = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

interface ArmBounds {
  readonly deadlineAtMs: number;
  readonly maxCheckIns: number;
}

/**
 * The arm-time bounds check, in the order §9 lists the codes.
 *
 * Returns an error code rather than a response so `edit` can reuse the same rules on the
 * fields it was actually given.
 */
const validateArmBounds = (body: WriteBody, nowMs: number): ArmBounds | string => {
  if (body.deadlineAtMs === undefined || body.deadlineAtMs === null) return "deadline_required";
  if (!Number.isFinite(body.deadlineAtMs)) return "invalid_body";
  if (body.deadlineAtMs <= nowMs) return "deadline_in_past";
  if (body.maxCheckIns === undefined || body.maxCheckIns === null) return "budget_required";
  if (!Number.isInteger(body.maxCheckIns)) return "invalid_body";
  if (body.maxCheckIns > MAX_CHECK_INS) return "budget_too_large";
  if (body.maxCheckIns < 1) return "budget_too_small";
  return { deadlineAtMs: body.deadlineAtMs, maxCheckIns: body.maxCheckIns };
};

/** The optional per-thread thresholds, shared by arm and edit. Never clamped either. */
const validateThresholds = (body: WriteBody): string | null => {
  for (const value of [body.idleMs, body.busyIdleMs]) {
    if (value === undefined || value === null) continue;
    if (!Number.isFinite(value) || value <= 0) return "invalid_body";
  }
  return null;
};

const SETTINGS_BOUNDS = {
  maxArmedThreads: { min: 1, max: 100, integer: true },
  defaultMaxCheckIns: { min: 1, max: MAX_CHECK_INS, integer: true },
  defaultRunMs: { min: 1, max: Number.MAX_SAFE_INTEGER, integer: false },
  defaultIdleMs: { min: 1, max: Number.MAX_SAFE_INTEGER, integer: false },
  defaultBusyIdleMs: { min: 1, max: Number.MAX_SAFE_INTEGER, integer: false },
} as const;

const validateSettings = (body: SettingsBody): string | null => {
  for (const [key, bounds] of Object.entries(SETTINGS_BOUNDS)) {
    const value = body[key as keyof typeof SETTINGS_BOUNDS];
    if (value === undefined) continue;
    if (!Number.isFinite(value)) return "invalid_body";
    if (bounds.integer && !Number.isInteger(value)) return "invalid_body";
    if (value < bounds.min || value > bounds.max) return "out_of_range";
  }
  return null;
};

// --- handlers ---------------------------------------------------------------

interface RouteDeps {
  readonly store: LoopStoreShape;
  readonly engine: OrchestrationEngineShape;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly crypto: Crypto.Crypto;
}

/**
 * A shell read that distinguishes "no such thread" from "the projection is unavailable".
 *
 * Collapsing them would report a transient SQL failure as a deleted thread, and the console
 * would offer to re-arm a loop that is fine.
 */
const readShell = (deps: RouteDeps, threadId: string) =>
  deps.snapshotQuery.getThreadShellById(ThreadId.make(threadId)).pipe(
    Effect.map((option) => ({ ok: true, shell: Option.getOrNull(option) }) as const),
    Effect.catch((cause) =>
      Effect.logWarning("coil loop: thread shell lookup failed", { threadId, cause }).pipe(
        Effect.as({ ok: false, shell: null } as const),
      ),
    ),
  );

/**
 * Dispatches a pin or unpin, reporting whether it landed.
 *
 * Best-effort by design, but the *result* is load-bearing: `pinnedByLoop` records what
 * actually happened, so a pin that failed can never authorise an unpin later.
 */
const dispatchPinCommand = (deps: RouteDeps, threadId: string, type: "thread.pin" | "unpin") =>
  Effect.gen(function* () {
    const uuid = yield* deps.crypto.randomUUIDv4;
    yield* deps.engine.dispatch(
      type === "thread.pin"
        ? {
            type: "thread.pin",
            commandId: CommandId.make(`coil-loop-pin:${uuid}`),
            threadId: ThreadId.make(threadId),
          }
        : {
            type: "thread.unpin",
            commandId: CommandId.make(`coil-loop-unpin:${uuid}`),
            threadId: ThreadId.make(threadId),
          },
    );
    return true;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("coil loop: pin command failed", { threadId, type, cause }).pipe(
        Effect.as(false),
      ),
    ),
  );

const buildView = (deps: RouteDeps, threadId: string, shell: OrchestrationThreadShell | null) =>
  Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const record = yield* deps.store.getThread(threadId);
    const global = yield* deps.store.getGlobal;
    const armed = yield* deps.store.listArmed;
    return {
      threadId,
      record,
      derived: deriveView({ record, shell, global, armedCount: armed.length, nowMs }),
      blockers: record.blockers.filter((entry) => entry.answeredAtMs === null),
      ledger: record.checkIns,
    } satisfies LoopView;
  });

const respondWithView = (
  deps: RouteDeps,
  threadId: string,
  shell: OrchestrationThreadShell | null,
) => Effect.map(buildView(deps, threadId, shell), (view) => HttpServerResponse.jsonUnsafe(view));

const settingsView = (deps: RouteDeps) =>
  Effect.gen(function* () {
    const global = yield* deps.store.getGlobal;
    const armed = yield* deps.store.listArmed;
    return { ...global, armedCount: armed.length } satisfies LoopSettingsView;
  });

/**
 * Arm or re-arm.
 *
 * One handler for both because a re-arm *is* a fresh run — the store clears the terminal
 * state, the budget and the ledger — and the two actions differ only in what the console
 * called the button.
 */
const handleArm = (deps: RouteDeps, body: WriteBody, nowMs: number) =>
  Effect.gen(function* () {
    const bounds = validateArmBounds(body, nowMs);
    if (typeof bounds === "string") return fail(400, bounds);
    const thresholdError = validateThresholds(body);
    if (thresholdError !== null) return fail(400, thresholdError);

    // Guard 14 at the route. The thread's own arm does not count against the ceiling, so
    // re-arming an already-armed loop is never refused by it.
    const global = yield* deps.store.getGlobal;
    const armed = yield* deps.store.listArmed;
    const others = armed.filter((entry) => entry.threadId !== body.threadId).length;
    if (others >= global.maxArmedThreads) {
      return fail(400, "ceiling_reached", { armedCount: others, max: global.maxArmedThreads });
    }

    const lookup = yield* readShell(deps, body.threadId);
    if (!lookup.ok) return fail(503, "projection_unavailable");
    if (lookup.shell === null) return fail(404, "unknown_thread");

    // `thread.pin` clears a snooze as a side effect of promotion, so refuse rather than
    // silently cancel one. Checked before any dispatch AND before any store write.
    const snoozedUntilMs = parseIsoMs(lookup.shell.snoozedUntil ?? null);
    if (snoozedUntilMs !== null && snoozedUntilMs > nowMs) {
      return fail(400, "thread_snoozed", { snoozedUntilMs });
    }

    // Only a pin this route created may ever be removed by this route — and a re-arm must
    // not disown one it already owns. The thread is pinned on a re-arm precisely *because*
    // the previous arm pinned it, so reading "already pinned" as "the user's pin" would
    // orphan it: `pinnedByLoop` would drop to false and no disarm would ever unpin.
    const previous = yield* deps.store.getThread(body.threadId);
    const alreadyPinned = parseIsoMs(lookup.shell.pinnedAt ?? null) !== null;
    const pinnedByLoop = alreadyPinned
      ? previous.pinnedByLoop
      : yield* dispatchPinCommand(deps, body.threadId, "thread.pin");

    yield* deps.store.arm({
      threadId: body.threadId,
      armedAtMs: nowMs,
      deadlineAtMs: bounds.deadlineAtMs,
      maxCheckIns: bounds.maxCheckIns,
      goal: body.goal ?? null,
      ...(provided(body.idleMs) ? { idleMs: body.idleMs } : {}),
      ...(provided(body.busyIdleMs) ? { busyIdleMs: body.busyIdleMs } : {}),
      ...(body.overridePrompt === undefined ? {} : { overridePrompt: body.overridePrompt }),
      pinnedByLoop,
    });

    return yield* respondWithView(deps, body.threadId, lookup.shell);
  });

/**
 * Disarm — the human taking over.
 *
 * Writes the sticky `handed-back` terminal rather than merely clearing `armed`, because
 * budget is deliberately *not* reset: deciding to stop a thread must not hand the next
 * loop a fresh six.
 *
 * Needs no shell, and that is deliberate: disarming must keep working when the thread has
 * been deleted from under the record. A one-way door is a bug.
 *
 * **Refused unless the loop is armed.** A stale tab holding a disarm button would otherwise
 * overwrite a `done` or `spent` terminal with `handed-back` hours later, rewriting how the
 * night ended, and a disarm of a thread that never had a loop would mint a terminal record
 * for a run that never existed.
 */
const handleDisarm = (deps: RouteDeps, body: WriteBody, nowMs: number) =>
  Effect.gen(function* () {
    const record = yield* deps.store.getThread(body.threadId);
    if (!record.armed) return fail(409, "not_armed");
    // Cleared only when the unpin actually landed. A failed unpin leaves the flag set, so a
    // later disarm can still remove the pin the loop is still responsible for.
    const unpinned =
      record.pinnedByLoop && (yield* dispatchPinCommand(deps, body.threadId, "unpin"));

    yield* deps.store.stop(body.threadId, {
      reason: "handed-back",
      atMs: nowMs,
      detail: "disarmed from the console",
    });
    if (unpinned) {
      yield* deps.store.update(body.threadId, (current) => ({ ...current, pinnedByLoop: false }));
    }
    // The agent's own wakes outlive the record that bounded them, and this route cannot end a
    // session itself. Bank the request; the supervisor's next tick issues the one `stopSession`
    // — the same call its own disarm path makes, on the same code path.
    if (hasPendingCrons(record, nowMs)) {
      yield* deps.store.requestSessionStop(body.threadId, nowMs);
    }
    const lookup = yield* readShell(deps, body.threadId);
    return yield* respondWithView(deps, body.threadId, lookup.shell);
  });

/**
 * Clear a finished run — the reverse of arming, for a loop that already ended.
 *
 * Without it the stopped pill and its bounds sit above the composer forever unless the thread
 * is armed again, which is a one-way door in the other direction. Refused while the loop is
 * armed, so this can never be a way to end a live run silently: that is `disarm`, which
 * records why.
 */
const handleClear = (deps: RouteDeps, body: WriteBody) =>
  Effect.gen(function* () {
    const record = yield* deps.store.getThread(body.threadId);
    if (record.armed) return fail(409, "armed");
    yield* deps.store.clearThread(body.threadId);
    const lookup = yield* readShell(deps, body.threadId);
    return yield* respondWithView(deps, body.threadId, lookup.shell);
  });

/**
 * Edit the bounds of a run in flight, without touching its budget or its ledger.
 *
 * Every field is optional and every one that is present is validated with the same rules
 * arming uses — extending a deadline into the past is as wrong here as it is there.
 *
 * **Refused unless the loop is armed**, for the same reason `disarm` is: editing the bounds
 * of a run that is over would resurrect its numbers without resurrecting the run, and
 * editing a thread that never had a loop would create a record out of a form submission.
 */
const handleEdit = (deps: RouteDeps, body: WriteBody, nowMs: number) =>
  Effect.gen(function* () {
    if (!(yield* deps.store.getThread(body.threadId)).armed) return fail(409, "not_armed");
    if (body.deadlineAtMs !== undefined && body.deadlineAtMs !== null) {
      if (!Number.isFinite(body.deadlineAtMs)) return fail(400, "invalid_body");
      if (body.deadlineAtMs <= nowMs) return fail(400, "deadline_in_past");
    }
    if (body.maxCheckIns !== undefined && body.maxCheckIns !== null) {
      if (!Number.isInteger(body.maxCheckIns)) return fail(400, "invalid_body");
      if (body.maxCheckIns > MAX_CHECK_INS) return fail(400, "budget_too_large");
      if (body.maxCheckIns < 1) return fail(400, "budget_too_small");
    }
    const thresholdError = validateThresholds(body);
    if (thresholdError !== null) return fail(400, thresholdError);

    yield* deps.store.update(body.threadId, (record) => ({
      ...record,
      ...(provided(body.deadlineAtMs) ? { deadlineAtMs: body.deadlineAtMs } : {}),
      ...(provided(body.maxCheckIns) ? { maxCheckIns: body.maxCheckIns } : {}),
      ...(provided(body.idleMs) ? { idleMs: body.idleMs } : {}),
      ...(provided(body.busyIdleMs) ? { busyIdleMs: body.busyIdleMs } : {}),
      ...(body.goal === undefined ? {} : { goal: body.goal }),
      ...(body.overridePrompt === undefined ? {} : { overridePrompt: body.overridePrompt }),
    }));

    const lookup = yield* readShell(deps, body.threadId);
    return yield* respondWithView(deps, body.threadId, lookup.shell);
  });

// --- routes -----------------------------------------------------------------

const makeGetLoopRoute = (deps: RouteDeps) =>
  HttpRouter.add(
    "GET",
    LOOP_ROUTE_PATH,
    Effect.gen(function* () {
      yield* authenticate;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      if (Option.isNone(url)) return fail(400, "invalid_request");
      const threadId = url.value.searchParams.get("threadId");
      if (threadId === null || threadId === "") return fail(400, "missing_thread_id");

      // An unknown thread is a 200 with the fail-closed "off" record, NOT a 404: the console
      // opens on every thread and must render "no loop here" without an error path.
      const lookup = yield* readShell(deps, threadId);
      return yield* respondWithView(deps, threadId, lookup.shell);
    }).pipe(Effect.catchTags(routeAuthErrorTags)),
  );

const makePostLoopRoute = (deps: RouteDeps) =>
  HttpRouter.add(
    "POST",
    LOOP_ROUTE_PATH,
    Effect.gen(function* () {
      yield* authenticate;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* readJsonBody(request).pipe(
        Effect.flatMap(decodeWriteBody),
        Effect.map((decoded): WriteBody | null => decoded),
        Effect.orElseSucceed(() => null),
      );
      if (body === null || body.threadId.trim() === "") return fail(400, "invalid_body");

      const nowMs = yield* Clock.currentTimeMillis;
      switch (body.action) {
        case "arm":
        case "rearm":
          return yield* handleArm(deps, body, nowMs);
        case "disarm":
          return yield* handleDisarm(deps, body, nowMs);
        case "edit":
          return yield* handleEdit(deps, body, nowMs);
        case "clear":
          return yield* handleClear(deps, body);
      }
    }).pipe(Effect.catchTags(routeAuthErrorTags)),
  );

const makeListLoopsRoute = (deps: RouteDeps) =>
  HttpRouter.add(
    "GET",
    LOOPS_ROUTE_PATH,
    Effect.gen(function* () {
      yield* authenticate;
      const armed = yield* deps.store.listArmed;
      // Sorted by threadId: `Object.entries` order is insertion order, which depends on the
      // sequence of arms and would make this response unstable across restarts.
      const ordered = [...armed].sort((a, b) => (a.threadId < b.threadId ? -1 : 1));
      const loops: Array<LoopView> = [];
      for (const entry of ordered) {
        const lookup = yield* readShell(deps, entry.threadId);
        loops.push(yield* buildView(deps, entry.threadId, lookup.shell));
      }
      return HttpServerResponse.jsonUnsafe({ loops } satisfies LoopListView);
    }).pipe(Effect.catchTags(routeAuthErrorTags)),
  );

const makeGetSettingsRoute = (deps: RouteDeps) =>
  HttpRouter.add(
    "GET",
    LOOP_SETTINGS_ROUTE_PATH,
    Effect.gen(function* () {
      yield* authenticate;
      return HttpServerResponse.jsonUnsafe(yield* settingsView(deps));
    }).pipe(Effect.catchTags(routeAuthErrorTags)),
  );

const makePostSettingsRoute = (deps: RouteDeps) =>
  HttpRouter.add(
    "POST",
    LOOP_SETTINGS_ROUTE_PATH,
    Effect.gen(function* () {
      yield* authenticate;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* readJsonBody(request).pipe(
        Effect.flatMap(decodeSettingsBody),
        Effect.map((decoded): SettingsBody | null => decoded),
        Effect.orElseSucceed(() => null),
      );
      if (body === null) return fail(400, "invalid_body");
      const error = validateSettings(body);
      if (error !== null) return fail(400, error);

      // Lowering `maxArmedThreads` below the current armed count is accepted on purpose:
      // the excess loops stand down at the next tick with their budgets intact. The toggle
      // and its ceiling are guards, not a lifecycle, so neither ever disarms anything.
      yield* deps.store.setGlobal(body);
      return HttpServerResponse.jsonUnsafe(yield* settingsView(deps));
    }).pipe(Effect.catchTags(routeAuthErrorTags)),
  );

/**
 * Answer one deferred blocker.
 *
 * Idempotent by construction: `store.answerBlocker` keeps the first answer, so a double-click or
 * a retried request is not a second append and never overwrites what was already banked.
 * `deliveredToAgent` stays false — the answer is owed to the agent, and the next check-in prompt
 * is what discharges it.
 */
const makeAnswerRoute = (deps: RouteDeps) =>
  HttpRouter.add(
    "POST",
    LOOP_ANSWER_ROUTE_PATH,
    Effect.gen(function* () {
      yield* authenticate;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* readJsonBody(request).pipe(
        Effect.flatMap(decodeAnswerBody),
        Effect.map((decoded): AnswerBody | null => decoded),
        Effect.orElseSucceed(() => null),
      );
      if (body === null || body.threadId.trim() === "" || body.blockerId.trim() === "") {
        return fail(400, "invalid_body");
      }

      const nowMs = yield* Clock.currentTimeMillis;
      const answered = yield* deps.store.answerBlocker(
        body.threadId,
        body.blockerId,
        body.answer,
        nowMs,
      );
      // An id nobody raised is a 404, not a silent success: the console would otherwise show an
      // answer as banked while nothing was recorded.
      if (answered === null) return fail(404, "not_found");
      return HttpServerResponse.jsonUnsafe({ ok: true });
    }).pipe(Effect.catchTags(routeAuthErrorTags)),
  );

/**
 * Mounted from `coil/index.ts`, which discharges `LoopStore`.
 *
 * `Layer.unwrap` resolves the services once at *layer construction* and the handlers close
 * over the values, so the handlers' own requirement stays `never`. That is what keeps
 * `LoopStore` — a fork-only service — out of the type of upstream's `makeRoutesLayer`; a
 * fork change must never widen an upstream signature.
 *
 * `OrchestrationEngineService`, `ProjectionSnapshotQuery` and `Crypto` are deliberately left
 * open on the layer rather than provided here: all three are already requirements of
 * `makeRoutesLayer` (upstream's own orchestration API layer needs the first two), so leaving
 * them unsatisfied adds nothing to that signature and avoids constructing a second engine.
 */
export const loopRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const deps: RouteDeps = {
      store: yield* LoopStore,
      engine: yield* OrchestrationEngineService,
      snapshotQuery: yield* ProjectionSnapshotQuery,
      crypto: yield* Crypto.Crypto,
    };
    return Layer.mergeAll(
      makeGetLoopRoute(deps),
      makePostLoopRoute(deps),
      makeListLoopsRoute(deps),
      makeGetSettingsRoute(deps),
      makePostSettingsRoute(deps),
      makeAnswerRoute(deps),
    );
  }),
);
