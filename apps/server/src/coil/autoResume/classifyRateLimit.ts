/**
 * classifyRateLimit — pure, structured decode of a Claude rate-limit payload.
 *
 * The single place that knows the vendor's rate-limit shape, isolated so it is the one
 * thing to update if the SDK changes. Structured (not string matching): reads the
 * `SDKRateLimitInfo` carried by an `account.rate-limits.updated` runtime event.
 *
 * Ground truth (@anthropic-ai/claude-agent-sdk):
 *   SDKRateLimitEvent = { type: "rate_limit_event"; rate_limit_info: SDKRateLimitInfo; ... }
 *   SDKRateLimitInfo  = {
 *     status: "allowed" | "allowed_warning" | "rejected";
 *     resetsAt?: number;                 // epoch (seconds); exact reset time
 *     rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus"
 *                   | "seven_day_sonnet" | "overage";
 *     ...
 *   }
 *
 * ClaudeAdapter emits this as `payload.rateLimits = <SDKRateLimitEvent>`
 * (ClaudeAdapter.ts:2906-2915). This function is provider-agnostic in its parsing but is
 * only ever fed Claude payloads by the reactor (which gates on `provider === "claude"`).
 *
 * @module coil/autoResume/classifyRateLimit
 */

const KNOWN_STATUSES = new Set(["allowed", "allowed_warning", "rejected"]);

export interface RateLimitVerdict {
  readonly rejected: boolean;
  /** Epoch milliseconds of the window reset, or null when the SDK omitted it. */
  readonly resetsAtMs: number | null;
  readonly rateLimitType: string | null;
  readonly status: "allowed" | "allowed_warning" | "rejected";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Normalize an SDK `resetsAt` to epoch milliseconds. The SDK documents epoch, and in
 * practice emits seconds; anything that looks like seconds (i.e. too small to be a
 * plausible future ms timestamp) is scaled up. Returns null for absent/invalid input.
 */
export function normalizeResetsAtMs(resetsAt: unknown): number | null {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) {
    return null;
  }
  // 1e12 ms ≈ 2001-09; any epoch below that is seconds, not milliseconds.
  return resetsAt < 1e12 ? Math.round(resetsAt * 1000) : Math.round(resetsAt);
}

/**
 * Decode a rate-limit payload into a verdict, or undefined when the blob is not a
 * recognizable rate-limit info object (so the caller ignores it).
 */
export function classifyRateLimit(rateLimits: unknown): RateLimitVerdict | undefined {
  const outer = asRecord(rateLimits);
  if (outer === null) return undefined;

  // Prefer the nested `rate_limit_info`; fall back to the outer object so a future
  // adapter that forwards the info directly still classifies.
  const info = asRecord(outer.rate_limit_info) ?? outer;

  const status = info.status;
  if (typeof status !== "string" || !KNOWN_STATUSES.has(status)) {
    return undefined;
  }

  const rateLimitType = typeof info.rateLimitType === "string" ? info.rateLimitType : null;

  return {
    rejected: status === "rejected",
    resetsAtMs: normalizeResetsAtMs(info.resetsAt),
    rateLimitType,
    status: status as RateLimitVerdict["status"],
  };
}
