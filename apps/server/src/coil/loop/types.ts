/**
 * The pure input and output shapes the loop decision table is written against.
 *
 * Lives apart from `decide.ts` and `guards.ts` only so those two can import each other's
 * vocabulary without a cycle: `decide.ts` computes the trigger facts, `guards.ts` consumes
 * them, and both speak this file. Nothing here has a runtime body — a type-only module
 * costs no branches and no bundle.
 *
 * Everything the decision reads is a plain value: a number for the clock, the durable
 * record, a thread shell, and a handful of facts the reactor already has in hand. There is
 * no `Effect`, no store and no filesystem, which is what makes the whole table testable
 * without a server, a clock or a provider.
 *
 * @module coil/loop/types
 */

import type { OrchestrationThreadShell } from "@t3tools/contracts";

import type { LoopConfig } from "./config.ts";
import type { CheckInRow, LoopGlobalSettings, LoopRecord, StopRecord } from "./state.ts";

/**
 * Exactly the shell fields the decision reads.
 *
 * A real `OrchestrationThreadShell` is structurally assignable, so the reactor passes its
 * projection row straight through; a test builds the ten fields and nothing else. Narrowing
 * it here is also the enforcement of the two refusals in the design: `deletedAt` is not on
 * the shell at all (a deleted thread is an absent shell, i.e. `null`), and `pinnedAt` is
 * absent because the pin is an arm-time fact recorded on the record, never re-derived here.
 */
export type LoopThreadShell = Pick<
  OrchestrationThreadShell,
  | "updatedAt"
  | "archivedAt"
  | "settledOverride"
  | "snoozedUntil"
  | "session"
  | "latestTurn"
  | "latestUserMessageAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "backgroundLiveness"
>;

/** The user-visible state a decision puts the loop in. Derived, never stored. */
export type LoopPhase = "off" | "watching" | "self_pacing" | "standing_down" | "held" | "blocked";

/**
 * Why a tick did nothing. Every one of these is non-consuming: the budget is untouched and
 * the loop stays armed, which is what distinguishes a stand-down from a stop.
 */
export type StandDownReason =
  | "disabled"
  | "stopped"
  | "not_armed"
  | "snoozed"
  | "pending_approval"
  | "pending_user_input"
  | "pending_plan"
  | "auto_resume_pending"
  | "rate_limited"
  | "self_pacing"
  | "check_in_floor"
  | "not_idle"
  | "ceiling";

/** The thread is no longer a destination a check-in could reach. */
export type DisarmReason = "thread_gone" | "archived";

/** The four terminal reasons, and they are `StopRecord`'s literals rather than a second set. */
export type StopOutcome = StopRecord["reason"];

/**
 * Which fact ended the run.
 *
 * Separate from `StopOutcome` because the record only stores four reasons while the console
 * and the breadcrumb want to say *why*: a deadline and an exhausted budget both report
 * `spent`, and that is deliberate — `spent` is never rendered as success.
 */
export type StopCause = "deadline" | "budget" | "sentinel" | "loop_done" | "strikes" | "takeover";

/** Retired numbers (5, 13) are not reused, so a case number cited anywhere keeps meaning. */
export type GuardId = "2" | "3" | "4" | "4b" | "6" | "8" | "9" | "10" | "10b" | "11" | "12" | "14";

/** How the previous check-in is judged, in `CheckInRow`'s own vocabulary. */
export type CheckInOutcome = CheckInRow["outcome"];

/** A recorded wake, resolved against the record and the shell. */
export interface ResolvedWake {
  readonly cronId: string;
  readonly atMs: number;
  /**
   * How late this wake may land before it counts as lost — derived from the entry, never a
   * constant. See `wakeGraceMs`.
   */
  readonly graceMs: number;
  /**
   * At or before the run's deadline. Past the deadline there is nothing left to defer to,
   * so an unbounded `CronCreate` expression cannot stand supervision down for a day.
   */
  readonly deferrable: boolean;
  /** `updatedAt` moved past the wake, so it landed and there is nothing to cover. */
  readonly landed: boolean;
}

/** The §4 arithmetic, computed once per decision and read by guards 10b, 11 and 12. */
export interface TriggerFacts {
  /** Clamped at 0 and floored by `processStartedAtMs`; never `NaN`, never negative. */
  readonly idleForMs: number;
  /** `busyIdleMs` or `idleMs`, chosen by `busyTurn`. */
  readonly thresholdMs: number;
  /** Lengthens the fuse. It is never a veto — see `resolveTrigger`. */
  readonly busyTurn: boolean;
  readonly wake: ResolvedWake | null;
}

export interface LoopDecisionInput {
  readonly nowMs: number;
  /** Boot-grace floor. Without it every armed thread fires at once on the first tick. */
  readonly processStartedAtMs: number;
  readonly record: LoopRecord;
  readonly global: LoopGlobalSettings;
  /** `null` is `Option.none` from `getThreadShellById`: the thread is gone. */
  readonly shell: LoopThreadShell | null;
  /** Newest `.coil/loop-done` mtime across both roots, or `null`. Never file contents. */
  readonly sentinelAtMs: number | null;
  /** When the agent called `loop_done`, or `null`. Equivalent to the file. */
  readonly loopDoneAtMs: number | null;
  /** Auto-resume has a pending resume armed for this thread (guard 9). */
  readonly autoResumePending: boolean;
  /**
   * Armed loops machine-wide, **including this one**. Guard 14 measures the others against
   * the ceiling, so the count it is handed must include the loop under evaluation.
   */
  readonly armedCount: number;
  readonly config: LoopConfig;
}

export interface LoopGuardInput extends LoopDecisionInput {
  readonly trigger: TriggerFacts;
}

export interface GuardFire {
  readonly kind: "fire";
  /** The pre-dispatch shell showed `settledOverride: "active"` — repair it after the turn. */
  readonly repairPin: boolean;
  /** A recorded wake went past its grace with no activity. */
  readonly degrade: "wake_lost" | null;
}

export interface GuardStandDown {
  readonly kind: "stand_down";
  readonly guard: GuardId;
  readonly reason: StandDownReason;
  readonly phase: LoopPhase;
  /** When the reason expires, for the console and the `{ reason, until? }` breadcrumb. */
  readonly untilMs: number | null;
}

export interface GuardDisarm {
  readonly kind: "disarm";
  readonly guard: "4";
  readonly reason: DisarmReason;
}

export interface GuardStop {
  readonly kind: "stop";
  readonly guard: "4b";
  readonly outcome: StopOutcome;
  readonly cause: StopCause;
  readonly detail: string;
}

export type GuardOutcome = GuardFire | GuardStandDown | GuardDisarm | GuardStop;

/** What the reactor reserves before it dispatches. */
export interface LoopCheckIn {
  /** 1-based. */
  readonly n: number;
  readonly of: number;
  readonly firedAtMs: number;
  /** The strike count to persist with this check-in: 0 on movement, +1 without. */
  readonly strikes: number;
  /** How the *previous* check-in turned out; `unknown` when there was none. */
  readonly previousOutcome: CheckInOutcome;
}

export interface StandDownAction {
  readonly type: "stand_down";
  readonly guard: GuardId;
  readonly reason: StandDownReason;
  readonly phase: LoopPhase;
  readonly untilMs: number | null;
}

export interface FireAction {
  readonly type: "fire";
  readonly kind: "check_in" | "wake_lost";
  readonly repairPin: boolean;
  readonly degrade: "wake_lost" | null;
  readonly checkIn: LoopCheckIn;
}

export interface StopAction {
  readonly type: "stop";
  readonly outcome: StopOutcome;
  readonly cause: StopCause;
  readonly detail: string;
  /**
   * End the provider session as well, because T3 has no write handle on the binary's cron
   * table and a bound that cannot stop the agent is not a bound.
   */
  readonly stopSession: boolean;
}

export interface DisarmAction {
  readonly type: "disarm";
  readonly reason: DisarmReason;
}

export type LoopAction = StandDownAction | FireAction | StopAction | DisarmAction;
