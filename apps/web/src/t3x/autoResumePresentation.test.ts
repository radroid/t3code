import { describe, expect, it } from "vite-plus/test";

import type { AutoResumeState } from "./autoResumeClient";
import {
  describeAutoResumeTooltip,
  describePendingReason,
  formatAutoResumeStatus,
  formatCountdown,
  formatNextAttempt,
} from "./autoResumePresentation";

const RESUME_AT_MS = Date.UTC(2026, 7, 8, 15, 47, 0);

const state = (overrides: Partial<AutoResumeState> = {}): AutoResumeState => ({
  enabled: true,
  overridePrompt: null,
  pending: null,
  ...overrides,
});

describe("formatCountdown", () => {
  it("formats minutes and zero-padded seconds", () => {
    expect(formatCountdown(4 * 60_000 + 12_000)).toBe("4:12");
  });

  it("zero-pads seconds below ten", () => {
    expect(formatCountdown(60_000 + 5_000)).toBe("1:05");
  });

  it("rounds partial seconds up so the countdown never shows a value it has passed", () => {
    expect(formatCountdown(1_500)).toBe("0:02");
  });

  it("switches to h:mm:ss past an hour", () => {
    expect(formatCountdown(3_600_000 + 4 * 60_000 + 12_000)).toBe("1:04:12");
  });

  it("clamps at zero rather than showing a negative countdown", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-90_000)).toBe("0:00");
  });
});

describe("formatAutoResumeStatus", () => {
  it("reports off", () => {
    expect(formatAutoResumeStatus(state({ enabled: false }))).toBe("Auto-resume: off");
  });

  it("reports on with nothing scheduled", () => {
    expect(formatAutoResumeStatus(state())).toBe("Auto-resume: on");
  });

  it("includes the next attempt when a resume is scheduled", () => {
    const status = formatAutoResumeStatus(
      state({ pending: { resumeAtMs: RESUME_AT_MS, reason: "usage limit" } }),
    );
    expect(status).toContain("Auto-resume: on · next attempt ~");
    expect(status).toContain(formatNextAttempt(RESUME_AT_MS));
  });
});

describe("describeAutoResumeTooltip", () => {
  it("always titles the tooltip Auto-resume", () => {
    for (const value of [
      state({ enabled: false }),
      state(),
      state({ pending: { resumeAtMs: RESUME_AT_MS, reason: "usage limit" } }),
    ]) {
      expect(describeAutoResumeTooltip(value).title).toBe("Auto-resume");
    }
  });

  it("explains the disabled state", () => {
    expect(describeAutoResumeTooltip(state({ enabled: false })).detail).toBe("Off for this thread");
  });

  it("explains the idle state", () => {
    expect(describeAutoResumeTooltip(state()).detail).toBe("On · nothing scheduled");
  });

  it("recovers the absolute time the capsule countdown drops", () => {
    const copy = describeAutoResumeTooltip(
      state({ pending: { resumeAtMs: RESUME_AT_MS, reason: "usage limit" } }),
    );
    expect(copy.detail).toBe(`Next attempt ~${formatNextAttempt(RESUME_AT_MS)}`);
  });
});

describe("describePendingReason", () => {
  it("falls back to a bare Paused when the reactor gave no reason", () => {
    expect(describePendingReason("")).toBe("Paused");
  });

  it("includes the reason when there is one", () => {
    expect(describePendingReason("usage limit reached")).toBe("Paused: usage limit reached");
  });
});
