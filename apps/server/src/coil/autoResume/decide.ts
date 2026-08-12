/**
 * Pure scheduling decision for auto-resume.
 *
 * Separated from the reactor's IO so the tricky parts — dedupe and reset-vs-backoff
 * timing — are exhaustively unit-testable.
 *
 * @module coil/autoResume/decide
 */

import type { AutoResumeConfig } from "./config.ts";
import { backoffDelayMs } from "./config.ts";
import type { RateLimitVerdict } from "./classifyRateLimit.ts";

export interface SchedulePlan {
  readonly kind: "schedule";
  readonly resumeAtMs: number;
}

export interface SkipPlan {
  readonly kind: "skip";
  readonly reason: "already-pending" | "not-rejected" | "capped";
}

export interface PlanScheduleInput {
  readonly verdict: RateLimitVerdict;
  /**
   * `resumeAtMs` of this thread's pending resume, or null when nothing is armed.
   * Still one-pending-per-thread — a new plan replaces the arm rather than adding one.
   */
  readonly pendingResumeAtMs: number | null;
  readonly nowMs: number;
  /** Fires for this thread within the recent backoff window — drives the ladder. */
  readonly firedRecently: number;
  /** Fires for this thread within the rolling 24h cap window. */
  readonly firedInCapWindow: number;
  readonly config: AutoResumeConfig;
}

/**
 * Decide whether/when to schedule a resume for a rejection.
 *
 * Dedup is "one pending per thread": while a resume is pending we skip every telemetry
 * re-emit (no churn). Once a resume fires, its pending is cleared, so the next rejection
 * re-arms naturally — and because `firedRecently` has incremented, its resume is spaced
 * out on the backoff ladder rather than tight-looping.
 *
 * One narrow exception (radroid/t3code#39): a rejection that names a CONCRETE reset time
 * LATER than the pending one supersedes it. A `seven_day` limit landing on top of an
 * armed `five_hour` used to be dropped outright, so the arm fired into a window that was
 * still shut and burned an attempt. The exception is deliberately restricted to
 * `windowOpensInFuture` — a ladder-derived time is `nowMs + delay`, which grows with
 * every re-emit, so allowing those to supersede would push the arm out forever and flood
 * the timeline with reschedule notes. An earlier reset time never supersedes either: the
 * existing arm is already the conservative choice.
 *
 * The 24h cap is checked HERE (at schedule time) as well as at fire time. Checking it at
 * schedule time stops a capped-out thread from re-scheduling — and re-posting a misleading
 * "auto-resume scheduled" timeline note — on every subsequent rejection until the fires
 * age out of the window. The fire-time check remains as defence-in-depth.
 *
 * Timing:
 *   - window opens in the future (`resetsAt > now`): wait until `resetsAt + margin`.
 *   - window already open (or absent) but still rejected: the reset time is stale /
 *     the limit persists, so retry on the backoff ladder from `now`.
 *
 * This deliberately uses NO persistent per-signature dedup: a signature keyed on a
 * volatile fired-count or a fixed reset time either collides across episodes (permanent
 * skip) or blocks re-arming a persistent limit. One-pending + backoff avoids both.
 */
export function planSchedule(input: PlanScheduleInput): SchedulePlan | SkipPlan {
  const { verdict, pendingResumeAtMs, nowMs, firedRecently, firedInCapWindow, config } = input;

  if (!verdict.rejected) return { kind: "skip", reason: "not-rejected" };

  const windowOpensInFuture = verdict.resetsAtMs !== null && verdict.resetsAtMs > nowMs;
  const resumeAtMs = windowOpensInFuture
    ? verdict.resetsAtMs! + config.safetyMarginMs
    : nowMs + backoffDelayMs(config.backoffLadderMs, firedRecently);

  if (pendingResumeAtMs !== null) {
    const supersedes = windowOpensInFuture && resumeAtMs > pendingResumeAtMs;
    if (!supersedes) return { kind: "skip", reason: "already-pending" };
  }
  if (firedInCapWindow >= config.maxResumesPer24h) return { kind: "skip", reason: "capped" };

  return { kind: "schedule", resumeAtMs };
}
