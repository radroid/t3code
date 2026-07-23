import { describe, expect, it } from "vite-plus/test";

import { resolveConfig } from "./config.ts";
import { planSchedule } from "./decide.ts";
import type { RateLimitVerdict } from "./classifyRateLimit.ts";

const config = resolveConfig({}); // defaults: margin 60s, backoff 15/30/60m
const rejected = (o: Partial<RateLimitVerdict> = {}): RateLimitVerdict => ({
  rejected: true,
  resetsAtMs: 1_000_000,
  rateLimitType: "five_hour",
  status: "rejected",
  ...o,
});

describe("planSchedule", () => {
  it("schedules at resetsAt + safety margin when the window opens in the future", () => {
    const plan = planSchedule({
      verdict: rejected({ resetsAtMs: 1_000_000 }),
      hasPending: false,
      nowMs: 500_000,
      firedRecently: 0,
      config,
    });
    expect(plan.kind).toBe("schedule");
    if (plan.kind !== "schedule") return;
    expect(plan.resumeAtMs).toBe(1_000_000 + config.safetyMarginMs);
  });

  it("skips a non-rejected verdict", () => {
    expect(
      planSchedule({
        verdict: rejected({ rejected: false }),
        hasPending: false,
        nowMs: 0,
        firedRecently: 0,
        config,
      }),
    ).toEqual({ kind: "skip", reason: "not-rejected" });
  });

  it("skips when a resume is already pending (dedupes telemetry re-emits)", () => {
    expect(
      planSchedule({
        verdict: rejected(),
        hasPending: true,
        nowMs: 0,
        firedRecently: 0,
        config,
      }),
    ).toEqual({ kind: "skip", reason: "already-pending" });
  });

  it("uses backoff from now when resetsAt is absent (offset applied to nowMs)", () => {
    const nowMs = 1_000_000; // non-zero so the `nowMs +` term is actually exercised
    const plan = planSchedule({
      verdict: rejected({ resetsAtMs: null }),
      hasPending: false,
      nowMs,
      firedRecently: 1,
      config,
    });
    if (plan.kind !== "schedule") throw new Error("expected schedule");
    expect(plan.resumeAtMs).toBe(nowMs + config.backoffLadderMs[1]!); // attempt 1 -> 30m
  });

  it("uses backoff from now when the reset time is already in the past (stale/persistent limit)", () => {
    const nowMs = 2_000_000;
    const plan = planSchedule({
      verdict: rejected({ resetsAtMs: 1_000_000 }), // already passed
      hasPending: false,
      nowMs,
      firedRecently: 2,
      config,
    });
    if (plan.kind !== "schedule") throw new Error("expected schedule");
    // Does NOT reuse the stale resetsAt; climbs the ladder (attempt 2 -> 60m cap) from now.
    expect(plan.resumeAtMs).toBe(nowMs + config.backoffLadderMs[2]!);
  });

  it("caps the backoff ladder at its last rung", () => {
    const plan = planSchedule({
      verdict: rejected({ resetsAtMs: null }),
      hasPending: false,
      nowMs: 5_000,
      firedRecently: 99,
      config,
    });
    if (plan.kind !== "schedule") throw new Error("expected schedule");
    expect(plan.resumeAtMs).toBe(
      5_000 + config.backoffLadderMs[config.backoffLadderMs.length - 1]!,
    );
  });
});
