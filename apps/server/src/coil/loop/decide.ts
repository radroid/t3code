/**
 * The loop decision table, pure.
 *
 * `decide` takes the durable record, a thread shell, the clock as a number and a handful of
 * facts the reactor already holds, and returns the single action to execute. Being pure is
 * the most important structural choice in the feature: the whole table tests without a
 * server, a clock or a provider, which is the only reason a design this full of orderings
 * can be trusted.
 *
 * It reads. It never writes. Nothing here mutates the record — the reactor persists what the
 * returned action asks for, and every stand-down asks for nothing, which is what makes
 * "a skip never spends budget" a property rather than a promise.
 *
 * ## The trigger (§4)
 *
 * ```
 * idleForMs  = now - max(Date.parse(shell.updatedAt), processStartedAtMs)
 * busyTurn   = session.status ∈ {running, starting} || latestTurn.state === "running"
 *           || backgroundLiveness != null
 * threshold  = busyTurn ? record.busyIdleMs : record.idleMs
 *
 * wake       = earliest recorded nextFireAtMs
 * deferrable = wake <= record.deadlineAtMs
 * fire when idleForMs >= threshold && !(deferrable && now < wake + grace(entry))
 * ```
 *
 * Both boundaries are inclusive: at exactly the threshold it fires, and at exactly
 * `wake + grace` the wake counts as lost.
 *
 * **`session.status` never vetoes a fire — it only lengthens the fuse.** Gating on it
 * deadlocks the exact threads this feature is for: the session reaper skips any binding whose
 * thread still has an `activeTurnId`, so a turn whose completion never arrives pins `running`
 * with nothing automated to clear it. `backgroundLiveness` is read the same way and for a
 * stricter reason — it is in-memory and empty after a restart, which is the exact gap this
 * feature closes, so a veto on it would fail silent precisely when supervision matters.
 *
 * On a healthy self-pacing thread this should almost never fire. How rarely it fires is the
 * measure of a correct implementation.
 *
 * @module coil/loop/decide
 */

import { wakeGraceMs } from "./config.ts";
import { periodMsAfter } from "./cron/parse.ts";
import { evaluateGuards, hasPendingCrons, isClaudeThread, isoMs, STRIKE_LIMIT } from "./guards.ts";
import type { CronEntry, LoopRecord } from "./state.ts";
import type {
  CheckInOutcome,
  LoopAction,
  LoopDecisionInput,
  LoopThreadShell,
  ResolvedWake,
  StopAction,
  StopOutcome,
  TriggerFacts,
} from "./types.ts";

/**
 * When the thread last moved, from `updatedAt` alone.
 *
 * `updatedAt` and nothing else, because it is a SQL projection column rather than a hot
 * stream: background subagent work lands there as activity appends, and it is the only
 * signal in the field that survives a mid-loop server restart.
 *
 * Unparseable reads as *now* — idle 0, no fire. A timestamp we cannot read is not evidence
 * the thread is stale, and `NaN` arithmetic would silently compare false in both directions.
 */
function movedAtMs(shell: LoopThreadShell, nowMs: number): number {
  return isoMs(shell.updatedAt) ?? nowMs;
}

/** `running` and `starting` lengthen the fuse. They never veto. */
function isBusyTurn(shell: LoopThreadShell): boolean {
  const status = shell.session?.status;
  if (status === "running" || status === "starting") return true;
  if (shell.latestTurn?.state === "running") return true;
  return typeof shell.backgroundLiveness === "string";
}

/**
 * The provider's cron table is in-process, so the recorded snapshot only describes a live
 * session. Once the session is gone or stopped the entries describe wakes that can no longer
 * fire, and deferring to them would stand supervision down forever.
 */
function cronsAreLive(shell: LoopThreadShell): boolean {
  const session = shell.session;
  if (session === null) return false;
  return session.status !== "stopped";
}

/**
 * Newest entry per id.
 *
 * A re-arm records the same cron twice in one snapshot; the later write is the current one,
 * and without this the older copy could win the `earliest wake` comparison and defer to a
 * fire time that was already superseded.
 */
function newestPerId(entries: ReadonlyArray<CronEntry>): ReadonlyArray<CronEntry> {
  const byId = new Map<string, CronEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
}

/**
 * The wake T3 defers to: the earliest recorded `nextFireAtMs`.
 *
 * `null` at every step means *no deference from that entry* — an unparseable schedule, a
 * non-Claude thread, a dead session or a record that never observed the hook must never
 * stand supervision down. Deference is bounded by the run's own deadline, because
 * `CronCreate` takes an unbounded 5-field expression: a recorded `0 9 * * *` would otherwise
 * stand supervision down for 24 hours, and a one-shot pinned days out indefinitely, all
 * while the run is nominally armed. Past the deadline there is nothing left to defer to.
 */
export function resolveWake(input: LoopDecisionInput): ResolvedWake | null {
  const { record, shell } = input;
  // Liveness before provenance: a dead session's entries describe wakes that can no longer
  // fire whatever wrote them.
  if (shell === null || !cronsAreLive(shell) || !isClaudeThread(shell)) return null;
  const crons = record.crons;
  if (crons === null) return null;

  let best: { readonly entry: CronEntry; readonly atMs: number } | null = null;
  for (const entry of newestPerId(crons.entries)) {
    const atMs = entry.nextFireAtMs;
    if (atMs === null) continue;
    if (best === null || atMs < best.atMs) best = { entry, atMs };
  }
  if (best === null) return null;

  const { entry, atMs } = best;
  // The period the derived grace scales with, measured from the wake itself so a schedule
  // recorded hours ago still yields its own cadence rather than the cadence from `now`.
  const periodMs = entry.recurring ? periodMsAfter(entry.schedule, atMs) : null;
  return {
    cronId: entry.id,
    atMs,
    graceMs: wakeGraceMs({ recurring: entry.recurring, periodMs }, input.config),
    deferrable: atMs <= record.deadlineAtMs,
    // Raw `updatedAt`, deliberately NOT floored by `processStartedAtMs`: the boot clamp
    // would read a restart as the wake having landed, which is the one case this signal
    // exists to catch.
    landed: movedAtMs(shell, input.nowMs) > atMs,
  };
}

/** The §4 arithmetic, computed once and handed to guards 10b, 11 and 12. */
export function resolveTrigger(input: LoopDecisionInput): TriggerFacts {
  const { record, shell, nowMs } = input;
  if (shell === null) {
    return { idleForMs: 0, thresholdMs: record.idleMs, busyTurn: false, wake: null };
  }
  const busyTurn = isBusyTurn(shell);
  // The boot-grace floor. Without it every armed thread fires simultaneously on the first
  // post-restart tick; it also covers laptop sleep and the restart-continuation window.
  const lastActivityMs = Math.max(movedAtMs(shell, nowMs), input.processStartedAtMs);
  return {
    // Clamped at 0 so clock skew reads as "just moved" rather than a negative idle.
    idleForMs: Math.max(0, nowMs - lastActivityMs),
    thresholdMs: busyTurn ? record.busyIdleMs : record.idleMs,
    busyTurn,
    wake: resolveWake(input),
  };
}

/**
 * How the previous check-in turned out, and the strike count that follows from it.
 *
 * Movement is `updatedAt` advancing past the moment we nudged, measured on the raw
 * projection value rather than the boot-clamped one — after a restart the clamp would credit
 * the agent with work it never did. Strikes are consecutive, not cumulative: any productive
 * check-in resets them to zero, so unproductive → productive → unproductive is still running.
 */
export function judgeProgress(input: LoopDecisionInput): {
  readonly outcome: CheckInOutcome;
  readonly strikes: number;
} {
  const { record, shell, config } = input;
  const last = record.lastCheckIn;
  const updatedAtMs = shell === null ? null : isoMs(shell.updatedAt);
  if (last === null || updatedAtMs === null) {
    return { outcome: "unknown", strikes: record.strikes };
  }
  if (updatedAtMs - last.firedAtMs >= config.productiveMs) {
    return { outcome: "productive", strikes: 0 };
  }
  return { outcome: "unproductive", strikes: record.strikes + 1 };
}

/**
 * Whether ending the run also has to end the provider session.
 *
 * Only when the run is over with the agent still live and its own wakes still pending:
 * `spent` (a deadline or an exhausted budget) and `stalled`. Not `done` — the agent said it
 * finished and killing the session would take any live background work with it — and
 * emphatically not `handed-back`, where the human is at the keyboard and the session we would
 * kill is the turn they just started.
 */
function stopsSession(outcome: StopOutcome, record: LoopRecord, nowMs: number): boolean {
  if (outcome !== "spent" && outcome !== "stalled") return false;
  return hasPendingCrons(record, nowMs);
}

/**
 * The one entry point.
 *
 * Guards decide *whether*; this decides *what*, and adds the two things a guard cannot see:
 * the strike projection that turns a second consecutive dead check-in into `stalled` before
 * the nudge rather than after it, and the reservation the reactor persists before it
 * dispatches.
 */
export function decide(input: LoopDecisionInput): LoopAction {
  const outcome = evaluateGuards({ ...input, trigger: resolveTrigger(input) });

  switch (outcome.kind) {
    case "stand_down":
      return {
        type: "stand_down",
        guard: outcome.guard,
        reason: outcome.reason,
        phase: outcome.phase,
        untilMs: outcome.untilMs,
      };
    case "disarm":
      return { type: "disarm", reason: outcome.reason };
    case "stop":
      return toStop(outcome.outcome, outcome.cause, outcome.detail, input);
    case "fire": {
      const progress = judgeProgress(input);
      if (progress.strikes >= STRIKE_LIMIT) {
        return toStop(
          "stalled",
          "strikes",
          `${progress.strikes} consecutive unproductive check-ins`,
          input,
        );
      }
      return {
        type: "fire",
        kind: outcome.degrade === "wake_lost" ? "wake_lost" : "check_in",
        repairPin: outcome.repairPin,
        degrade: outcome.degrade,
        checkIn: {
          // Reserved before dispatch: a provider that cannot spawn burns budget instead of
          // tight-looping. Six attempts, not four hundred and eighty a night.
          n: input.record.checkInsUsed + 1,
          of: input.record.maxCheckIns,
          firedAtMs: input.nowMs,
          strikes: progress.strikes,
          previousOutcome: progress.outcome,
        },
      };
    }
  }
}

function toStop(
  outcome: StopOutcome,
  cause: StopAction["cause"],
  detail: string,
  input: LoopDecisionInput,
): StopAction {
  return {
    type: "stop",
    outcome,
    cause,
    detail,
    stopSession: stopsSession(outcome, input.record, input.nowMs),
  };
}
