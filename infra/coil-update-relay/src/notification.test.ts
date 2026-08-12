import { describe, expect, it } from "vite-plus/test";

import { parseNotification, supersedes } from "./notification.ts";

describe("parseNotification", () => {
  it("accepts a body carrying a positive integer buildNumber", () => {
    const result = parseNotification(JSON.stringify({ buildNumber: 42, shortSha: "abc123def456" }));
    expect(result).toEqual({ ok: true, envelope: { buildNumber: 42 } });
  });

  it("ignores every field except buildNumber", () => {
    // The relay must stay usable when the manifest gains fields it has never heard of. If this
    // test ever needs updating to add a field, the relay has started parsing the manifest and
    // has acquired a lockstep-deploy dependency on the app.
    const result = parseNotification(
      JSON.stringify({ buildNumber: 7, somethingAddedNextYear: { nested: true } }),
    );
    expect(result).toEqual({ ok: true, envelope: { buildNumber: 7 } });
  });

  it.each([
    ["not json at all", "{"],
    ["a JSON array", "[]"],
    ["a JSON string", '"hello"'],
    ["null", "null"],
  ])("rejects %s", (_label, body) => {
    expect(parseNotification(body).ok).toBe(false);
  });

  it.each([
    ["a missing buildNumber", {}],
    ["a string buildNumber", { buildNumber: "12" }],
    ["a zero buildNumber", { buildNumber: 0 }],
    ["a negative buildNumber", { buildNumber: -1 }],
    ["a fractional buildNumber", { buildNumber: 1.5 }],
    ["an unsafe integer buildNumber", { buildNumber: Number.MAX_SAFE_INTEGER + 2 }],
  ])("rejects %s", (_label, body) => {
    expect(parseNotification(JSON.stringify(body)).ok).toBe(false);
  });
});

describe("supersedes", () => {
  it("accepts anything when nothing is stored yet", () => {
    expect(supersedes(1, null)).toBe(true);
  });

  it("accepts a strictly higher build", () => {
    expect(supersedes(11, 10)).toBe(true);
  });

  it("rejects a repeat of the build it already holds", () => {
    // A retried notify must not re-broadcast: every connected app would be woken for a build it
    // already knows about.
    expect(supersedes(10, 10)).toBe(false);
  });

  it("rejects an older build, which is the downgrade case", () => {
    // The release matrix has two legs. A slow Windows leg from run 10 can land after run 11's
    // macOS leg has already published. Accepting it would move every client backwards onto an
    // older build while reporting success — the least visible failure in the whole system.
    expect(supersedes(10, 11)).toBe(false);
  });
});
