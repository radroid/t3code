/**
 * The loop's own budget readout, derived from the durable record alone.
 *
 * This is the shell-free half of `http.ts`'s `deriveView`: the subset of the state machine
 * that can be stated truthfully from `{ record, global, nowMs }` plus, optionally, a thread
 * shell. It exists because `loop_status` is answered inside an MCP tool call, which has a
 * `LoopStore` and nothing else — no projection query, no thread shell, no tick.
 *
 * Two properties hold and are what the tool depends on:
 *
 *  1. **It never fails.** Every branch returns a status. An agent asking how much budget it
 *     has left must never be handed an error it then has to reason about mid-turn.
 *  2. **A missing shell is not a state.** When `shell` is `null` the shell-derived clauses
 *     (snooze, blocked-on-a-human) are simply skipped rather than reported as `off` or
 *     `blocked`. `http.ts` distinguishes "the thread is gone" with its own `threadKnown`;
 *     conflating the two here would have `loop_status` tell a running agent its thread does
 *     not exist.
 *
 * The state literals are `LoopDerivedView["state"]`'s, deliberately, so the console and the
 * tool cannot drift into two vocabularies for one machine. This module is the intended home
 * of that derivation — `deriveView` can adopt it by passing its shell through.
 *
 * @module coil/loop/status
 */

import { blockingRequest, isoMs, isRateLimited, isSnoozed } from "./guards.ts";
import type { LoopGlobalSettings, LoopRecord } from "./state.ts";
import type { LoopThreadShell } from "./types.ts";

/** The same seven literals `http.ts` renders, so one machine has one vocabulary. */
export type LoopStatusState =
  | "off"
  | "watching"
  | "self_pacing"
  | "standing_down"
  | "held"
  | "blocked"
  | "stopped";

export interface LoopStatusInput {
  readonly nowMs: number;
  readonly record: LoopRecord;
  readonly global: LoopGlobalSettings;
  /** `null` = no shell facts to hand. The shell clauses are skipped, never guessed. */
  readonly shell: LoopThreadShell | null;
}

export interface LoopStatus {
  /**
   * Supervised right now — armed, not stopped, and the master toggle on.
   *
   * Deliberately *not* `record.armed`. An agent asking whether it is being watched wants
   * the operational answer, and a loop standing down behind a switched-off master toggle
   * is not being watched. The console reads `record.armed` for the raw fact.
   */
  readonly armed: boolean;
  readonly state: LoopStatusState;
  /** Why, when the state alone does not say. `null` for `watching`. */
  readonly reason: string | null;
  readonly checkInsUsed: number;
  readonly maxCheckIns: number;
  readonly deadlineAtMs: number;
  /** Clamped at 0: a passed deadline reads as "no time left", never as negative time. */
  readonly msToDeadline: number;
  /** Earliest recorded wake that parsed, past or future. `null` = no deference available. */
  readonly nextWakeAtMs: number | null;
}

/** Earliest recorded wake that parsed. `null` entries mean "no deference", not "now". */
export function earliestWakeMs(record: LoopRecord): number | null {
  let earliest: number | null = null;
  for (const entry of record.crons?.entries ?? []) {
    const next = entry.nextFireAtMs;
    if (next === null) continue;
    if (earliest === null || next < earliest) earliest = next;
  }
  return earliest;
}

/**
 * The record's reading of the state machine, in the guard table's order.
 *
 * Terminal first — a stop is sticky and outranks every live reading, including the master
 * toggle — then `off`, so an unarmed thread never reports a guard's opinion of it.
 */
export function deriveLoopStatus(input: LoopStatusInput): LoopStatus {
  const { nowMs, record, global, shell } = input;
  const nextWakeAtMs = earliestWakeMs(record);
  const base = {
    checkInsUsed: record.checkInsUsed,
    maxCheckIns: record.maxCheckIns,
    deadlineAtMs: record.deadlineAtMs,
    msToDeadline: Math.max(0, record.deadlineAtMs - nowMs),
    nextWakeAtMs,
  };

  if (record.stopped !== null) {
    return { ...base, armed: false, state: "stopped", reason: record.stopped.reason };
  }
  if (!record.armed) return { ...base, armed: false, state: "off", reason: "no-loop" };
  // Guard 2: the toggle stands loops down; it disarms and stops nothing, so `armed` stays
  // true. The tool reports the toggle separately — this is a state, not a disarm.
  if (!global.enabled) {
    return { ...base, armed: false, state: "standing_down", reason: "disabled" };
  }
  if (shell !== null && isSnoozed(shell, nowMs)) {
    return {
      ...base,
      armed: true,
      state: "blocked",
      reason: "snoozed",
      nextWakeAtMs: isoMs(shell.snoozedUntil) ?? nextWakeAtMs,
    };
  }
  if (shell !== null) {
    const blocked = blockingRequest(shell);
    if (blocked !== null) return { ...base, armed: true, state: "blocked", reason: blocked };
  }
  if (isRateLimited(record, nowMs)) {
    return { ...base, armed: true, state: "held", reason: "rate_limited" };
  }
  // Guard 10b, conservatively: only a wake still ahead of us and inside the run's deadline
  // is visible deference. A wake past due is the reactor's call, since whether it is merely
  // late or genuinely lost depends on the derived grace.
  if (nextWakeAtMs !== null && nextWakeAtMs > nowMs && nextWakeAtMs <= record.deadlineAtMs) {
    return { ...base, armed: true, state: "self_pacing", reason: null };
  }
  return { ...base, armed: true, state: "watching", reason: null };
}
