import { describe, expect, it } from "vite-plus/test";

import {
  createSignature,
  MAX_TIMESTAMP_SKEW_SECONDS,
  parseTimestamp,
  signingMaterial,
  verifySignature,
} from "./signature.ts";

const SECRET = "test-secret";
const NOW = 1_800_000_000;
const BODY = JSON.stringify({ buildNumber: 3, shortSha: "0123456789ab" });

async function signedRequest(overrides: { timestamp?: number; body?: string } = {}) {
  const timestamp = overrides.timestamp ?? NOW;
  const rawBody = overrides.body ?? BODY;
  return {
    signatureHeader: await createSignature({ secret: SECRET, timestamp, rawBody }),
    timestampHeader: String(timestamp),
    rawBody,
  };
}

describe("signingMaterial", () => {
  it("binds the timestamp to the body", () => {
    // If the timestamp were not inside the signed material it could be rewritten in transit to
    // refresh a captured request indefinitely, which is the entire point of having it.
    expect(signingMaterial("123", "{}")).toBe("123.{}");
  });
});

describe("parseTimestamp", () => {
  it("accepts a timestamp inside the window", () => {
    expect(parseTimestamp(String(NOW - 10), NOW)).toEqual({ ok: true, timestamp: NOW - 10 });
  });

  it("rejects a timestamp older than the window", () => {
    const result = parseTimestamp(String(NOW - MAX_TIMESTAMP_SKEW_SECONDS - 1), NOW);
    expect(result.ok).toBe(false);
  });

  it("rejects a timestamp from the future", () => {
    // Absolute skew, not just "too old". A request signed with a far-future clock would
    // otherwise stay replayable forever.
    const result = parseTimestamp(String(NOW + MAX_TIMESTAMP_SKEW_SECONDS + 1), NOW);
    expect(result.ok).toBe(false);
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["non-numeric", "not-a-number"],
    ["zero", "0"],
    ["negative", "-5"],
  ])("rejects a %s timestamp", (_label, header) => {
    expect(parseTimestamp(header, NOW).ok).toBe(false);
  });
});

describe("verifySignature", () => {
  it("accepts a correctly signed body", async () => {
    const request = await signedRequest();
    const result = await verifySignature({ secret: SECRET, nowSeconds: NOW, ...request });
    expect(result).toEqual({ ok: true });
  });

  it("rejects a body modified after signing", async () => {
    const request = await signedRequest();
    const result = await verifySignature({
      secret: SECRET,
      nowSeconds: NOW,
      ...request,
      rawBody: JSON.stringify({ buildNumber: 999, shortSha: "attackercommit" }),
    });
    expect(result).toEqual({ ok: false, failure: { kind: "mismatch" } });
  });

  it("rejects a signature made with a different secret", async () => {
    const timestamp = NOW;
    const result = await verifySignature({
      secret: SECRET,
      nowSeconds: NOW,
      signatureHeader: await createSignature({ secret: "wrong-secret", timestamp, rawBody: BODY }),
      timestampHeader: String(timestamp),
      rawBody: BODY,
    });
    expect(result).toEqual({ ok: false, failure: { kind: "mismatch" } });
  });

  it("rejects a valid signature replayed outside the window", async () => {
    const request = await signedRequest({ timestamp: NOW - MAX_TIMESTAMP_SKEW_SECONDS - 60 });
    const result = await verifySignature({ secret: SECRET, nowSeconds: NOW, ...request });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.kind).toBe("timestamp-skew");
  });

  it("rejects a timestamp swapped for a fresh one", async () => {
    // Capture a real request, then try to extend its life by advancing only the header.
    const request = await signedRequest({ timestamp: NOW - 1_000 });
    const result = await verifySignature({
      secret: SECRET,
      nowSeconds: NOW,
      ...request,
      timestampHeader: String(NOW),
    });
    expect(result).toEqual({ ok: false, failure: { kind: "mismatch" } });
  });

  it.each([
    ["missing", null, "missing-signature"],
    ["empty", "", "missing-signature"],
    ["unprefixed", "deadbeef", "malformed-signature"],
    ["odd-length hex", "sha256=abc", "malformed-signature"],
    ["non-hex", "sha256=zzzz", "malformed-signature"],
  ])("rejects a %s signature header", async (_label, header, expected) => {
    const result = await verifySignature({
      secret: SECRET,
      nowSeconds: NOW,
      signatureHeader: header,
      timestampHeader: String(NOW),
      rawBody: BODY,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.kind).toBe(expected);
  });
});
