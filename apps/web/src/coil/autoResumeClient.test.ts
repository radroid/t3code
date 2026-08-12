import { describe, expect, it } from "vite-plus/test";

import { parseAutoResumePending, parseAutoResumeState } from "./autoResumeClient";

describe("parseAutoResumePending", () => {
  it("parses a well-formed pending entry", () => {
    expect(parseAutoResumePending({ resumeAtMs: 1_000, reason: "usage limit" })).toEqual({
      resumeAtMs: 1_000,
      reason: "usage limit",
    });
  });

  it("defaults a missing or non-string reason to an empty string", () => {
    expect(parseAutoResumePending({ resumeAtMs: 1_000 })?.reason).toBe("");
    expect(parseAutoResumePending({ resumeAtMs: 1_000, reason: 42 })?.reason).toBe("");
  });

  it("rejects a non-finite resumeAtMs rather than scheduling against NaN", () => {
    expect(parseAutoResumePending({ resumeAtMs: Number.NaN })).toBeNull();
    expect(parseAutoResumePending({ resumeAtMs: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("rejects a missing or wrongly-typed resumeAtMs", () => {
    expect(parseAutoResumePending({})).toBeNull();
    expect(parseAutoResumePending({ resumeAtMs: "soon" })).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(parseAutoResumePending(null)).toBeNull();
    expect(parseAutoResumePending(undefined)).toBeNull();
    expect(parseAutoResumePending([])).toBeNull();
    expect(parseAutoResumePending("pending")).toBeNull();
  });
});

describe("parseAutoResumeState", () => {
  it("parses a full state", () => {
    expect(
      parseAutoResumeState({
        enabled: true,
        overridePrompt: "keep going",
        pending: { resumeAtMs: 1_000, reason: "usage limit" },
      }),
    ).toEqual({
      enabled: true,
      overridePrompt: "keep going",
      pending: { resumeAtMs: 1_000, reason: "usage limit" },
    });
  });

  it("treats an empty override prompt as absent so the placeholder shows", () => {
    expect(parseAutoResumeState({ enabled: true, overridePrompt: "" })?.overridePrompt).toBeNull();
  });

  it("treats a non-string override prompt as absent", () => {
    expect(parseAutoResumeState({ enabled: true, overridePrompt: 7 })?.overridePrompt).toBeNull();
  });

  it("keeps state when pending is absent or malformed", () => {
    expect(parseAutoResumeState({ enabled: true })?.pending).toBeNull();
    expect(parseAutoResumeState({ enabled: true, pending: { reason: "x" } })?.pending).toBeNull();
  });

  it("rejects a payload with no boolean enabled — the one field the overlay cannot infer", () => {
    expect(parseAutoResumeState({})).toBeNull();
    expect(parseAutoResumeState({ enabled: "yes" })).toBeNull();
    expect(parseAutoResumeState({ enabled: 1 })).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(parseAutoResumeState(null)).toBeNull();
    expect(parseAutoResumeState([])).toBeNull();
    expect(parseAutoResumeState("enabled")).toBeNull();
  });
});
