/**
 * Pure scheduling decision for auto-resume.
 *
 * Separated from the reactor's IO so the tricky parts — dedupe and reset-vs-backoff
 * timing — are exhaustively unit-testable.
 *
 * @module t3x/autoResume/decide
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
  readonly reason: "already-pending" | "not-rejected";
}

export interface PlanScheduleInput {
  readonly verdict: RateLimitVerdict;
  /** Whether this thread already has a resume pending (one-per-thread invariant). */
  readonly hasPending: boolean;
  readonly nowMs: number;
  /** Fires for this thread within the recent backoff window — drives the ladder. */
  readonly firedRecently: number;
  readonly config: AutoResumeConfig;
}

/**
 * Decide whether/when to schedule a resume for a rejection.
 *
 * Dedup is purely "one pending per thread": while a resume is pending we skip every
 * telemetry re-emit (no churn). Once a resume fires, its pending is cleared, so the next
 * rejection re-arms naturally — and because `firedRecently` has incremented, its resume
 * is spaced out on the backoff ladder rather than tight-looping. The 24h cap (enforced
 * at fire time) is the hard stop.
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
  const { verdict, hasPending, nowMs, firedRecently, config } = input;

  if (!verdict.rejected) return { kind: "skip", reason: "not-rejected" };
  if (hasPending) return { kind: "skip", reason: "already-pending" };

  const windowOpensInFuture = verdict.resetsAtMs !== null && verdict.resetsAtMs > nowMs;
  const resumeAtMs = windowOpensInFuture
    ? verdict.resetsAtMs! + config.safetyMarginMs
    : nowMs + backoffDelayMs(config.backoffLadderMs, firedRecently);

  return { kind: "schedule", resumeAtMs };
}
