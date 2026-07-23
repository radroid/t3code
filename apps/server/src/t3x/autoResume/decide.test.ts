import { describe, expect, it } from "vite-plus/test";

import { resolveConfig } from "./config.ts";
import { planSchedule, type PlanScheduleInput } from "./decide.ts";
import type { RateLimitVerdict } from "./classifyRateLimit.ts";

const config = resolveConfig({}); // defaults: margin 60s, backoff 15/30/60m, cap 10/24h
const rejected = (o: Partial<RateLimitVerdict> = {}): RateLimitVerdict => ({
  rejected: true,
  resetsAtMs: 1_000_000,
  rateLimitType: "five_hour",
  status: "rejected",
  ...o,
});

// Base input = a fresh rejection, nothing pending, no prior fires, not capped.
const plan = (o: Partial<PlanScheduleInput> = {}) =>
  planSchedule({
    verdict: rejected(),
    hasPending: false,
    nowMs: 0,
    firedRecently: 0,
    firedInCapWindow: 0,
    config,
    ...o,
  });

describe("planSchedule", () => {
  it("schedules at resetsAt + safety margin when the window opens in the future", () => {
    const p = plan({ verdict: rejected({ resetsAtMs: 1_000_000 }), nowMs: 500_000 });
    expect(p.kind).toBe("schedule");
    if (p.kind !== "schedule") return;
    expect(p.resumeAtMs).toBe(1_000_000 + config.safetyMarginMs);
  });

  it("skips a non-rejected verdict", () => {
    expect(plan({ verdict: rejected({ rejected: false }) })).toEqual({
      kind: "skip",
      reason: "not-rejected",
    });
  });

  it("skips when a resume is already pending (dedupes telemetry re-emits)", () => {
    expect(plan({ hasPending: true })).toEqual({ kind: "skip", reason: "already-pending" });
  });

  it("skips when the thread has hit the 24h cap (stops re-scheduling + misleading notes)", () => {
    expect(plan({ firedInCapWindow: config.maxResumesPer24h })).toEqual({
      kind: "skip",
      reason: "capped",
    });
    // One below the cap still schedules.
    expect(plan({ firedInCapWindow: config.maxResumesPer24h - 1 }).kind).toBe("schedule");
  });

  it("uses backoff from now when resetsAt is absent (offset applied to nowMs)", () => {
    const nowMs = 1_000_000; // non-zero so the `nowMs +` term is actually exercised
    const p = plan({ verdict: rejected({ resetsAtMs: null }), nowMs, firedRecently: 1 });
    if (p.kind !== "schedule") throw new Error("expected schedule");
    expect(p.resumeAtMs).toBe(nowMs + config.backoffLadderMs[1]!); // attempt 1 -> 30m
  });

  it("uses backoff from now when the reset time is already in the past (stale/persistent limit)", () => {
    const nowMs = 2_000_000;
    const p = plan({ verdict: rejected({ resetsAtMs: 1_000_000 }), nowMs, firedRecently: 2 });
    if (p.kind !== "schedule") throw new Error("expected schedule");
    // Does NOT reuse the stale resetsAt; climbs the ladder (attempt 2 -> 60m cap) from now.
    expect(p.resumeAtMs).toBe(nowMs + config.backoffLadderMs[2]!);
  });

  it("caps the backoff ladder at its last rung", () => {
    const p = plan({ verdict: rejected({ resetsAtMs: null }), nowMs: 5_000, firedRecently: 99 });
    if (p.kind !== "schedule") throw new Error("expected schedule");
    expect(p.resumeAtMs).toBe(5_000 + config.backoffLadderMs[config.backoffLadderMs.length - 1]!);
  });
});
