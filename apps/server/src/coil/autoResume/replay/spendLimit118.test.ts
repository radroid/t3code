/**
 * Regression: the #118 spend-limit payloads must still arm a resume at the five_hour reset.
 *
 * Reconstructed from radroid/t3code#118 (thread 57e2846c-9cb1-40d4-8776-e5f7db3fe7b9,
 * 2026-08-17), where an overnight self-paced loop took three `account.rate-limits.updated`
 * events with `status:"rejected"` and never armed anything. Six hours were lost.
 *
 *   06:23:55.882  five_hour REJECTED, resetsAt 10:40:00Z, overageStatus "allowed"
 *   06:30:24.452  the same, overageStatus "allowed_warning"
 *   06:34:49.391  the same, overageStatus "rejected",
 *                 overageDisabledReason "org_level_disabled_until",
 *                 overageResetsAt 2026-09-01, isUsingOverage false
 *   06:39:37      session exits gracefully; the store still reads pending null, firedAtMs []
 *   10:40:00      the five_hour window reopens. Nothing happens.
 *
 * The issue named three hypotheses. This file answers the second — "never armed, because
 * the parser did not read this payload shape as rejected" — and answers it NO: the decision
 * path arms on all three. What made the episode plausible is that these payloads are the
 * first in the fork's evidence to carry the SDK's newer overage fields, and the last of the
 * three reads, in prose, as a hard stop: overage rejected, disabled at org level, not back
 * until 2026-09-01. If any of that leaked into the verdict the reactor would have skipped.
 * It does not, and this pins that: `classifyRateLimit` reads `rate_limit_info.status` and
 * nothing else, so a four-field verdict is the whole of what reaches `planSchedule`.
 *
 * Which leaves the target itself. `overageResetsAt` is two weeks out and is NOT the resume
 * time — the five_hour bucket's own reset is, because included quota returns when that
 * window reopens and `isUsingOverage` is already false by then. That is the issue's
 * hypothesis 3, and asserting the target explicitly is what keeps a future "model the spend
 * limit" change honest about which of the two times it is moving.
 *
 * Pure on purpose: every decision above lives in `classifyRateLimit` + `planSchedule`, so a
 * reactor, a clock, and a harness would add moving parts without adding evidence. The
 * reactor-level replays next door cover the wiring.
 *
 * NOTE FOR ANYONE CHANGING AUTO-RESUME: this file encodes an observed production payload.
 * If a change makes it fail, the payload did not change — the decision did.
 */

// @effect-diagnostics globalDate:off -- `iso` is a pure ms->ISO fixture helper over two
// constants captured from a provider log; no clock is read here.
import { describe, expect, it } from "vite-plus/test";

import { classifyRateLimit } from "../classifyRateLimit.ts";
import { resolveConfig } from "../config.ts";
import { planSchedule } from "../decide.ts";

const config = resolveConfig({}); // defaults: 60s safety margin, 10 resumes / 24h

/** Epoch ms as an ISO string, so the assertions below name times a human can check. */
const iso = (ms: number) => new Date(ms).toISOString();

/** The five_hour bucket's reset, as the SDK sent it: epoch SECONDS. 2026-08-17T10:40:00Z. */
const RESETS_AT_SECONDS = 1_786_963_200;
const RESETS_AT_MS = RESETS_AT_SECONDS * 1000;

/** When org-level overage returns: 2026-09-01T00:00:00Z. Two weeks out, and not a target. */
const OVERAGE_RESETS_AT_SECONDS = 1_788_220_800;

/** Shape mirrors @anthropic-ai/claude-agent-sdk SDKRateLimitEvent, as ClaudeAdapter forwards it. */
const event = (info: Record<string, unknown>) => ({
  type: "rate_limit_event",
  rate_limit_info: info,
  uuid: "u",
  session_id: "4def7c10-494d-40ef-a685-36ff485c36d6",
});

/**
 * The three events verbatim in shape, in timeline order (provider log lines 1170/1261/1343).
 * `nowMs` is the event's own timestamp, so each plan is computed from the moment it landed.
 */
const episode = [
  {
    at: "2026-08-17T06:23:55.882Z",
    overage: 'overageStatus "allowed", still on overage',
    rateLimits: event({
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: RESETS_AT_SECONDS,
      overageStatus: "allowed",
      isUsingOverage: true,
    }),
  },
  {
    at: "2026-08-17T06:30:24.452Z",
    overage: 'overageStatus "allowed_warning", still on overage',
    rateLimits: event({
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: RESETS_AT_SECONDS,
      overageStatus: "allowed_warning",
      isUsingOverage: true,
    }),
  },
  {
    at: "2026-08-17T06:34:49.391Z",
    overage: 'overageStatus "rejected", org_level_disabled_until — the spend limit itself',
    rateLimits: event({
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: RESETS_AT_SECONDS,
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled_until",
      overageResetsAt: OVERAGE_RESETS_AT_SECONDS,
      isUsingOverage: false,
    }),
  },
] as const;

/** The store's record for this thread at the time: enabled, nothing armed, nothing fired. */
const planFor = (verdict: NonNullable<ReturnType<typeof classifyRateLimit>>, nowMs: number) =>
  planSchedule({
    verdict,
    pendingResumeAtMs: null,
    nowMs,
    firedRecently: 0,
    firedInCapWindow: 0,
    config,
  });

describe("radroid/t3code#118 — the spend-limit episode, through the pure decision path", () => {
  for (const step of episode) {
    it(`arms at the five_hour reset for the ${step.at} event (${step.overage})`, () => {
      const verdict = classifyRateLimit(step.rateLimits);

      // The WHOLE verdict, not just `rejected`: four fields is the entire surface that
      // reaches `planSchedule`, so this is also the assertion that no overage field
      // survives the decode to colour the decision.
      expect(verdict).toEqual({
        rejected: true,
        resetsAtMs: RESETS_AT_MS,
        rateLimitType: "five_hour",
        status: "rejected",
      });
      expect(iso(RESETS_AT_MS)).toBe("2026-08-17T10:40:00.000Z");

      const plan = planFor(verdict!, Date.parse(step.at));

      expect(plan).toEqual({
        kind: "schedule",
        resumeAtMs: RESETS_AT_MS + config.safetyMarginMs,
      });
    });
  }

  it("targets the five_hour reset, never the 2026-09-01 overage reset", () => {
    // The last event is the one that could plausibly have argued for the later time: it is
    // the one that says overage is off until September.
    const spendLimited = episode[2];
    const verdict = classifyRateLimit(spendLimited.rateLimits)!;
    const plan = planFor(verdict, Date.parse(spendLimited.at));

    expect(plan.kind).toBe("schedule");
    if (plan.kind !== "schedule") return;
    expect(iso(plan.resumeAtMs)).toBe("2026-08-17T10:41:00.000Z");
    expect(plan.resumeAtMs).not.toBe(OVERAGE_RESETS_AT_SECONDS * 1000);
    // Not merely a different number — fifteen days earlier. A resume two weeks out is the
    // same lost overnight run this issue is about.
    expect(plan.resumeAtMs).toBeLessThan(OVERAGE_RESETS_AT_SECONDS * 1000);
  });
});
