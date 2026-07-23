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
  it("schedules at resetsAt + safety margin for a structured rejection", () => {
    const plan = planSchedule({
      verdict: rejected({ resetsAtMs: 1_000_000 }),
      pendingSignature: null,
      lastFiredSignature: null,
      nowMs: 0,
      firedRecently: 0,
      config,
    });
    expect(plan.kind).toBe("schedule");
    if (plan.kind !== "schedule") return;
    expect(plan.resumeAtMs).toBe(1_000_000 + config.safetyMarginMs);
    expect(plan.signature).toBe("five_hour:1000000");
  });

  it("skips a non-rejected verdict", () => {
    const plan = planSchedule({
      verdict: rejected({ rejected: false }),
      pendingSignature: null,
      lastFiredSignature: null,
      nowMs: 0,
      firedRecently: 0,
      config,
    });
    expect(plan).toEqual({ kind: "skip", reason: "not-rejected" });
  });

  it("dedupes an identical pending or already-fired signature", () => {
    const args = {
      verdict: rejected({ resetsAtMs: 1_000_000 }),
      nowMs: 0,
      firedRecently: 0,
      config,
    } as const;
    expect(
      planSchedule({ ...args, pendingSignature: "five_hour:1000000", lastFiredSignature: null }),
    ).toEqual({
      kind: "skip",
      reason: "already-pending",
    });
    expect(
      planSchedule({ ...args, pendingSignature: null, lastFiredSignature: "five_hour:1000000" }),
    ).toEqual({
      kind: "skip",
      reason: "already-fired",
    });
  });

  it("uses a DISTINCT signature per backoff attempt so the ladder can climb", () => {
    const mk = (firedRecently: number) =>
      planSchedule({
        verdict: rejected({ resetsAtMs: null }),
        pendingSignature: null,
        lastFiredSignature: `five_hour:backoff:${firedRecently - 1}`,
        nowMs: 0,
        firedRecently,
        config,
      });
    const first = mk(1);
    expect(first.kind).toBe("schedule");
    if (first.kind !== "schedule") return;
    // distinct from the previous fired signature -> not deduped
    expect(first.signature).toBe("five_hour:backoff:1");
    // climbs the ladder: attempt index 1 -> 30m
    expect(first.resumeAtMs).toBe(config.backoffLadderMs[1]);
  });

  it("caps the backoff ladder at its last rung", () => {
    const plan = planSchedule({
      verdict: rejected({ resetsAtMs: null }),
      pendingSignature: null,
      lastFiredSignature: null,
      nowMs: 0,
      firedRecently: 99,
      config,
    });
    if (plan.kind !== "schedule") throw new Error("expected schedule");
    expect(plan.resumeAtMs).toBe(config.backoffLadderMs[config.backoffLadderMs.length - 1]);
  });
});
