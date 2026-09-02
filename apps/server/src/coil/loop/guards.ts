/**
 * The loop guard table, pure.
 *
 * One function per guard plus `evaluateGuards`, which runs them in the design's exact order
 * and returns the *first* thing that blocks. That ordering is the product: the string the
 * first blocking guard returns is what the console renders, so "the loop is held" and "the
 * loop is over" can never be swapped.
 *
 * Every guard reads plain values — `nowMs`, the durable record, a thread shell, the global
 * settings, the resolved trigger facts. No store, no clock, no filesystem, no provider.
 *
 * ## Two orderings that are load-bearing
 *
 * **Guard 4b (the stop sweep) runs before every non-consuming skip.** Stop conditions are
 * facts about the *run*, not about the thread's current activity. With the sweep after the
 * idle guards — where it used to sit, as guard 13 — a thread that never went idle never
 * reached it, so a self-paced run strolled through its own deadline indefinitely and an
 * agent that wrote `.coil/loop-done` while still working was not recorded as `done` until it
 * happened to go quiet.
 *
 * **Guard 4b runs after guard 4, and guard 2 runs before both.** A deleted thread disarms
 * rather than reporting `spent`, and the master toggle stands loops down without
 * manufacturing terminal states nobody chose.
 *
 * ## Guard 5 is retired. Do not re-add it
 *
 * `settledOverride !== "settled"` was a skip meaning "the human is done here". It has not
 * meant that since upstream #8600 moved settlement server-side: `ThreadSettlementReactor`
 * sweeps every minute and dispatches `thread.auto-settle`, which shares `thread.settle`'s
 * decider case and emits the same event with **no provenance marker**. There is no
 * discriminator. `autoResume/guards.ts` already paid for this once — a timer destroyed an
 * armed week-long resume on day 3 — and keeping it here would have been worse, because a
 * skip never *stops*: an auto-settled loop would sit armed doing nothing until its deadline
 * and then report `spent`. The user's opt-out is disarm.
 *
 * Snooze is not in that position and guard 6 stands: there is no auto-snooze command, so
 * `snoozedUntil` still carries a human's intent. The general rule this fork keeps
 * re-learning: before adding any guard, ask *could a server timer write this value?*
 *
 * @module coil/loop/guards
 */

import { isClaudeThread } from "../autoResume/guards.ts";
import type { LoopConfig } from "./config.ts";
import type { LoopGlobalSettings, LoopRecord } from "./state.ts";
import type {
  GuardId,
  GuardOutcome,
  GuardStandDown,
  GuardStop,
  LoopGuardInput,
  LoopPhase,
  LoopThreadShell,
  StandDownReason,
  StopCause,
  TriggerFacts,
} from "./types.ts";

export { isClaudeThread };

/** Two *consecutive* unproductive check-ins end the run. Not cumulative. */
export const STRIKE_LIMIT = 2;

/** Epoch ms for an ISO timestamp, or `null` when it is absent or unparseable. */
export function isoMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Guard 2 — the master toggle, re-read every tick and again pre-dispatch. */
export function masterToggleOff(global: LoopGlobalSettings): boolean {
  return global.enabled !== true;
}

/** Guard 3, first half — terminal states are sticky; only a human re-arm clears them. */
export function isStopped(record: LoopRecord): boolean {
  return record.stopped !== null;
}

/** Guard 3, second half — nothing is supervised implicitly. */
export function isArmed(record: LoopRecord): boolean {
  return record.armed === true;
}

/** Guard 4 — the thread is archived, a destination a check-in should not reach. */
export function isArchived(shell: LoopThreadShell): boolean {
  return shell.archivedAt !== null;
}

/**
 * Guard 6 — a snooze is a human saying "not now", and honouring it is the only reason this
 * guard exists.
 *
 * An unparseable timestamp reads as *not* snoozed. A snooze that cannot be read is not an
 * instruction, and the failing-closed reading here would be a loop that never runs again
 * with nothing on the console explaining why.
 */
export function isSnoozed(shell: LoopThreadShell, nowMs: number): boolean {
  const until = isoMs(shell.snoozedUntil);
  return until !== null && until > nowMs;
}

/**
 * Guard 7 — not a blocker. When the pre-dispatch shell carries the keep-active pin the
 * reactor nudges and *then* repairs it, because the decider clears `settledOverride` for any
 * non-null value. Reported only when the pin is already there, so it can never create one.
 */
export function needsPinRepair(shell: LoopThreadShell): boolean {
  return shell.settledOverride === "active";
}

/**
 * Guard 8 — blocked on a human.
 *
 * The third clause is the one every design in the original panel missed: `Sidebar.logic.ts`
 * treats plan-ready as *not* pending-input, so a thread parked on an unapproved plan
 * otherwise passes every blocking guard and gets pushed past the human's yes.
 */
export function blockingRequest(shell: LoopThreadShell): StandDownReason | null {
  if (shell.hasPendingApprovals) return "pending_approval";
  if (shell.hasPendingUserInput) return "pending_user_input";
  if (shell.hasActionableProposedPlan) return "pending_plan";
  return null;
}

/** Guard 10 — a usage limit, held durably so it survives a restart. */
export function isRateLimited(record: LoopRecord, nowMs: number): boolean {
  return nowMs < record.rateLimitedUntilMs;
}

/**
 * Guard 10b — the deference rule.
 *
 * While a recorded wake is pending inside the run's deadline the agent is pacing itself and
 * T3 stands by: no dispatch, no budget spent. T3 wins the moment the wake is overdue by its
 * grace with no `updatedAt` movement — an unmet commitment rather than an inference, and the
 * strongest trigger in the design.
 */
export function wakeIsPending(trigger: TriggerFacts, nowMs: number): boolean {
  const wake = trigger.wake;
  if (wake === null || !wake.deferrable || wake.landed) return false;
  return nowMs < wake.atMs + wake.graceMs;
}

/**
 * A recorded wake that never landed. The boundary is inclusive: at exactly
 * `nextFireAtMs + graceMs` the wake counts as lost.
 */
export function wakeIsLost(trigger: TriggerFacts, nowMs: number): boolean {
  const wake = trigger.wake;
  if (wake === null || !wake.deferrable || wake.landed) return false;
  return nowMs >= wake.atMs + wake.graceMs;
}

/**
 * Guard 11 — the structural anti-tight-loop floor.
 *
 * Reads the deployment-level `config.idleMs` rather than the per-thread override, and the
 * clock rather than `updatedAt`, so a tight loop stays impossible even on a thread whose
 * `updatedAt` never bumps.
 */
export function checkInFloorMet(record: LoopRecord, config: LoopConfig, nowMs: number): boolean {
  const last = record.lastCheckIn;
  if (last === null) return true;
  return nowMs - last.firedAtMs >= config.idleMs;
}

/** Guard 12 — the staleness threshold. `>=` is inclusive: at exactly the threshold it fires. */
export function idleThresholdMet(trigger: TriggerFacts): boolean {
  return trigger.idleForMs >= trigger.thresholdMs;
}

/** Guard 14 — the machine-wide ceiling, re-checked here so hand-editing the file cannot bypass it. */
export function atArmedCeiling(armedCount: number, global: LoopGlobalSettings): boolean {
  return armedCount >= global.maxArmedThreads;
}

/**
 * The human took the wheel.
 *
 * Exact string compare against our own minted `createdAt`, which is the off-by-one that
 * would otherwise disarm every loop on its own first check-in: `latestUserMessageAt` equal
 * to the nudge we sent is the nudge, not a takeover. Before the first check-in the baseline
 * is `armedAtMs`, so a message typed after arming still counts.
 */
export function tookOver(record: LoopRecord, shell: LoopThreadShell): boolean {
  const latest = shell.latestUserMessageAt;
  if (typeof latest !== "string") return false;
  const last = record.lastCheckIn;
  if (last !== null) return latest > last.createdAtIso;
  const latestMs = isoMs(latest);
  return latestMs !== null && latestMs > record.armedAtMs;
}

/**
 * The done signal, from either channel.
 *
 * Freshness is the recorded mtime against `armedAtMs`, so a done-file left over from a
 * previous run is a leftover rather than a signal. Newest wins when both channels fired.
 */
export function doneSignal(input: {
  readonly record: LoopRecord;
  readonly sentinelAtMs: number | null;
  readonly loopDoneAtMs: number | null;
}): { readonly cause: Extract<StopCause, "sentinel" | "loop_done">; readonly atMs: number } | null {
  const armedAtMs = input.record.armedAtMs;
  const sentinel = input.sentinelAtMs;
  const called = input.loopDoneAtMs;
  const sentinelFresh = sentinel !== null && sentinel > armedAtMs;
  const calledFresh = called !== null && called > armedAtMs;
  if (sentinelFresh && calledFresh) {
    return sentinel >= called
      ? { cause: "sentinel", atMs: sentinel }
      : { cause: "loop_done", atMs: called };
  }
  if (sentinelFresh) return { cause: "sentinel", atMs: sentinel };
  if (calledFresh) return { cause: "loop_done", atMs: called };
  return null;
}

/**
 * Recorded wakes that would still fire if the session kept running.
 *
 * A recurring entry counts whatever its next fire time, because it reschedules itself. This
 * is what decides whether ending a run also has to end the session: T3 has no write handle
 * on the binary's cron table, and a bound that cannot stop the agent is not a bound.
 */
export function hasPendingCrons(record: LoopRecord, nowMs: number): boolean {
  const crons = record.crons;
  if (crons === null) return false;
  return crons.entries.some(
    (entry) => entry.recurring || (entry.nextFireAtMs !== null && entry.nextFireAtMs > nowMs),
  );
}

const stop = (outcome: GuardStop["outcome"], cause: StopCause, detail: string): GuardStop => ({
  kind: "stop",
  guard: "4b",
  outcome,
  cause,
  detail,
});

/**
 * Guard 4b — the stop sweep, in the design's order: deadline, budget, done, strikes,
 * takeover.
 *
 * `deadlineAtMs: 0` and `maxCheckIns: 0` are the fail-closed decoding defaults, and both
 * land here on the first evaluation: a deadline that did not survive a write means "over",
 * never "unbounded". `spent` covers both the deadline and the budget and is never reported
 * as `done` — the two words mean opposite things to the person reading the console in the
 * morning.
 *
 * Takeover is swept last, after the four conditions the design enumerates, so a run that was
 * already over on T3's clock reports why T3 ended it rather than attributing it to a message
 * typed afterwards.
 */
export function stopCondition(input: {
  readonly nowMs: number;
  readonly record: LoopRecord;
  readonly shell: LoopThreadShell;
  readonly sentinelAtMs: number | null;
  readonly loopDoneAtMs: number | null;
}): GuardStop | null {
  const { nowMs, record } = input;
  if (nowMs >= record.deadlineAtMs) {
    return stop("spent", "deadline", `deadline passed at ${record.deadlineAtMs}`);
  }
  if (record.checkInsUsed >= record.maxCheckIns) {
    return stop(
      "spent",
      "budget",
      `used ${record.checkInsUsed} of ${record.maxCheckIns} check-ins`,
    );
  }
  const done = doneSignal(input);
  if (done !== null) {
    return stop("done", done.cause, `${done.cause} at ${done.atMs}`);
  }
  if (record.strikes >= STRIKE_LIMIT) {
    return stop("stalled", "strikes", `${record.strikes} consecutive unproductive check-ins`);
  }
  if (tookOver(record, input.shell)) {
    return stop("handed-back", "takeover", `user message at ${input.shell.latestUserMessageAt}`);
  }
  return null;
}

const standDown = (
  guard: GuardId,
  reason: StandDownReason,
  phase: LoopPhase,
  untilMs: number | null = null,
): GuardStandDown => ({ kind: "stand_down", guard, reason, phase, untilMs });

/**
 * Run the table and return the first thing that blocks, or `fire`.
 *
 * The order is: 2 master toggle, 3 terminal/armed, 4 shell, **4b stop sweep**, 6 snooze,
 * 8 blocked on a human, 9 auto-resume, 10 rate limit, 10b deference, 11 check-in floor,
 * 12 idle threshold, 14 ceiling. Guards 5 and 13 are retired and their numbers are not
 * reused. Guard 7 is not a blocker — it rides out on the `fire` result as `repairPin`.
 */
export function evaluateGuards(input: LoopGuardInput): GuardOutcome {
  const { record, global, shell, nowMs, config, trigger } = input;

  // 2 — nothing is disarmed and nothing is stopped; budgets stay intact.
  if (masterToggleOff(global)) return standDown("2", "disabled", "standing_down");

  // 3 — sticky terminal first, so a stopped loop says so rather than "not armed".
  if (isStopped(record)) return standDown("3", "stopped", "off");
  if (!isArmed(record)) return standDown("3", "not_armed", "off");

  // 4 — the thread itself. `null` is `Option.none`: the thread was deleted.
  if (shell === null) return { kind: "disarm", guard: "4", reason: "thread_gone" };
  if (isArchived(shell)) return { kind: "disarm", guard: "4", reason: "archived" };

  // 4b — before every skip, because a stop is a fact about the run.
  const stopped = stopCondition({ ...input, shell });
  if (stopped !== null) return stopped;

  // 6
  if (isSnoozed(shell, nowMs)) {
    return standDown("6", "snoozed", "watching", isoMs(shell.snoozedUntil));
  }

  // 8
  const blocked = blockingRequest(shell);
  if (blocked !== null) return standDown("8", blocked, "blocked");

  // 9 — auto-resume owns this thread right now; two reactors must not both nudge it.
  if (input.autoResumePending) return standDown("9", "auto_resume_pending", "watching");

  // 10
  if (isRateLimited(record, nowMs)) {
    return standDown("10", "rate_limited", "held", record.rateLimitedUntilMs);
  }

  // 10b. `wake` is re-read here rather than through the predicate so the console gets the
  // time it is standing down until without a second null check that could never be true.
  const wake = trigger.wake;
  if (wake !== null && wakeIsPending(trigger, nowMs)) {
    return standDown("10b", "self_pacing", "self_pacing", wake.atMs);
  }

  // 11. Same shape: with no previous check-in there is no floor to be under.
  const last = record.lastCheckIn;
  if (last !== null && !checkInFloorMet(record, config, nowMs)) {
    return standDown("11", "check_in_floor", "watching", last.firedAtMs + config.idleMs);
  }

  // 12
  if (!idleThresholdMet(trigger)) return standDown("12", "not_idle", "watching");

  // 14
  if (atArmedCeiling(input.armedCount, global)) return standDown("14", "ceiling", "standing_down");

  return {
    kind: "fire",
    repairPin: needsPinRepair(shell),
    degrade: wakeIsLost(trigger, nowMs) ? "wake_lost" : null,
  };
}
