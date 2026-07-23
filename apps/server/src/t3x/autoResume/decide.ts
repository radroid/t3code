/**
 * Pure scheduling decision for auto-resume.
 *
 * Separated from the reactor's IO so the tricky parts — dedupe/re-arm and reset-vs-
 * backoff timing — are exhaustively unit-testable.
 *
 * @module t3x/autoResume/decide
 */

import type { AutoResumeConfig } from "./config.ts";
import { backoffDelayMs } from "./config.ts";
import type { RateLimitVerdict } from "./classifyRateLimit.ts";

export interface SchedulePlan {
  readonly kind: "schedule";
  readonly resumeAtMs: number;
  readonly signature: string;
}

export interface SkipPlan {
  readonly kind: "skip";
  readonly reason: "already-pending" | "already-fired" | "not-rejected";
}

export interface PlanScheduleInput {
  readonly verdict: RateLimitVerdict;
  readonly pendingSignature: string | null;
  readonly lastFiredSignature: string | null;
  readonly nowMs: number;
  readonly firedRecently: number;
  readonly config: AutoResumeConfig;
}

/**
 * Decide whether/when to schedule a resume for a rejection.
 *
 * Signature design (the re-arm key):
 *   - structured (`resetsAt` known): `<type>:<resetsAtMs>` — stable across telemetry
 *     re-emits of the SAME rejection (so it dedupes), but a genuinely new window carries
 *     a new `resetsAt` and thus a new signature (so it re-arms).
 *   - backoff (`resetsAt` absent): `<type>:backoff:<firedRecently>` — DISTINCT per
 *     attempt so the backoff ladder can climb instead of being deduped after one try.
 *     The 24h cap (enforced at fire time) bounds total attempts.
 */
export function planSchedule(input: PlanScheduleInput): SchedulePlan | SkipPlan {
  const { verdict, pendingSignature, lastFiredSignature, nowMs, firedRecently, config } = input;

  if (!verdict.rejected) return { kind: "skip", reason: "not-rejected" };

  const type = verdict.rateLimitType ?? "unknown";
  const signature =
    verdict.resetsAtMs !== null
      ? `${type}:${verdict.resetsAtMs}`
      : `${type}:backoff:${firedRecently}`;

  if (pendingSignature === signature) return { kind: "skip", reason: "already-pending" };
  if (lastFiredSignature === signature) return { kind: "skip", reason: "already-fired" };

  const resumeAtMs =
    verdict.resetsAtMs !== null
      ? verdict.resetsAtMs + config.safetyMarginMs
      : nowMs + backoffDelayMs(config.backoffLadderMs, firedRecently);

  return { kind: "schedule", resumeAtMs, signature };
}
