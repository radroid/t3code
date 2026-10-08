import { describe, expect, it } from "vite-plus/test";

import { classifyRateLimit, normalizeResetsAtMs } from "./classifyRateLimit.ts";

// Shapes mirror @anthropic-ai/claude-agent-sdk SDKRateLimitEvent / SDKRateLimitInfo.
const event = (info: Record<string, unknown>) => ({
  type: "rate_limit_event",
  rate_limit_info: info,
  uuid: "u",
  session_id: "s",
});

describe("classifyRateLimit", () => {
  it("classifies a rejected five_hour window with a reset time", () => {
    const resetSeconds = 1_800_000_000;
    const verdict = classifyRateLimit(
      event({ status: "rejected", rateLimitType: "five_hour", resetsAt: resetSeconds }),
    );
    expect(verdict).toEqual({
      rejected: true,
      resetsAtMs: resetSeconds * 1000,
      rateLimitType: "five_hour",
      status: "rejected",
    });
  });

  it("classifies allowed and allowed_warning as not rejected", () => {
    expect(classifyRateLimit(event({ status: "allowed" }))?.rejected).toBe(false);
    expect(classifyRateLimit(event({ status: "allowed_warning" }))?.rejected).toBe(false);
  });

  it("returns resetsAtMs null when the SDK omits resetsAt (backoff path)", () => {
    const verdict = classifyRateLimit(event({ status: "rejected", rateLimitType: "seven_day" }));
    expect(verdict).toEqual({
      rejected: true,
      resetsAtMs: null,
      rateLimitType: "seven_day",
      status: "rejected",
    });
  });

  it("reads the info directly when there is no nested rate_limit_info wrapper", () => {
    const verdict = classifyRateLimit({ status: "rejected", resetsAt: 2_000_000_000 });
    expect(verdict?.rejected).toBe(true);
    expect(verdict?.resetsAtMs).toBe(2_000_000_000 * 1000);
  });

  it("returns undefined for unrecognized / malformed blobs", () => {
    expect(classifyRateLimit(undefined)).toBeUndefined();
    expect(classifyRateLimit(null)).toBeUndefined();
    expect(classifyRateLimit("nope")).toBeUndefined();
    expect(classifyRateLimit({})).toBeUndefined();
    expect(classifyRateLimit(event({ status: "unknown_status" }))).toBeUndefined();
    expect(classifyRateLimit(event({ rateLimitType: "five_hour" }))).toBeUndefined();
  });

  it("tolerates a non-string rateLimitType", () => {
    const verdict = classifyRateLimit(event({ status: "rejected", rateLimitType: 5 }));
    expect(verdict?.rateLimitType).toBeNull();
  });
});

describe("normalizeResetsAtMs", () => {
  it("scales epoch seconds up to milliseconds", () => {
    expect(normalizeResetsAtMs(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it("passes epoch milliseconds through unchanged", () => {
    expect(normalizeResetsAtMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it("returns null for absent / non-positive / non-finite input", () => {
    expect(normalizeResetsAtMs(undefined)).toBeNull();
    expect(normalizeResetsAtMs(0)).toBeNull();
    expect(normalizeResetsAtMs(-5)).toBeNull();
    expect(normalizeResetsAtMs(Number.NaN)).toBeNull();
    expect(normalizeResetsAtMs("123")).toBeNull();
  });
});
