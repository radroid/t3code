import { describe, expect, it } from "vite-plus/test";

import { isVendorAuthoredText, mergeReports, redact, REDACTED } from "./redact.ts";

describe("redact — what must survive", () => {
  it("keeps a rate_limit_info subtree byte-for-byte", () => {
    // This subtree IS the fixture's payload. Every field here is read by
    // classifyRateLimit or is evidence about why it did not fire.
    const info = {
      status: "allowed",
      resetsAt: 1_786_402_800,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled_until",
      overageResetsAt: 1_788_220_800,
      isUsingOverage: false,
    };
    const { value } = redact({ type: "rate_limit_event", rate_limit_info: info });
    expect(value).toEqual({ type: "rate_limit_event", rate_limit_info: info });
  });

  it("keeps the structural fields of a limit-stopped result", () => {
    // is_error:true alongside subtype:"success" is the #118 contradiction; a fixture that
    // loses either field cannot express the defect.
    const { value } = redact({
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 1,
      duration_ms: 963,
    });
    expect(value).toEqual({
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 1,
      duration_ms: 963,
    });
  });

  it("keeps identifiers and timestamps so a replay reproduces the session", () => {
    const { value } = redact({
      uuid: "25e7bbc0-42be-468a-b96a-9c276e968a60",
      session_id: "e3bfdbb3-2abf-4f89-8ddd-164bc1b23b05",
      createdAt: "2026-08-10T22:35:41.614Z",
      // Identifier shape is honoured even under a key the allowlist has never seen.
      some_new_sdk_id: "5fc601a3-ef7e-4efa-afd4-da4657aa1e3a",
    });
    expect(value).toEqual({
      uuid: "25e7bbc0-42be-468a-b96a-9c276e968a60",
      session_id: "e3bfdbb3-2abf-4f89-8ddd-164bc1b23b05",
      createdAt: "2026-08-10T22:35:41.614Z",
      some_new_sdk_id: "5fc601a3-ef7e-4efa-afd4-da4657aa1e3a",
    });
  });

  it("keeps vendor-authored limit text, including on a synthetic assistant message", () => {
    const { value, report } = redact({
      type: "assistant",
      message: {
        role: "assistant",
        model: "<synthetic>",
        stop_reason: "stop_sequence",
        content: [
          {
            type: "text",
            text: "You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit",
          },
        ],
      },
    });
    expect(JSON.stringify(value)).toContain("individual spend limit");
    expect(report.keptVendorStrings).toBe(1);
  });
});

describe("redact — what must not survive", () => {
  it("redacts conversation text, tool input and filesystem paths", () => {
    const { value, report } = redact({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Here is the private API key handling in your billing code" },
          { type: "tool_use", name: "Read", input: { file_path: "/Users/someone/secrets.ts" } },
        ],
      },
      cwd: "/Users/someone/Developer/private-repo",
    });

    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain("private API key");
    expect(serialized).not.toContain("secrets.ts");
    expect(serialized).not.toContain("private-repo");
    // Structure survives so the replay still exercises the same code paths.
    expect(serialized).toContain('"type":"tool_use"');
    expect(serialized).toContain('"name":"Read"');
    expect(report.redactedStrings).toBe(3);
  });

  it("leaks nothing from an unknown message shape — the allowlist direction", () => {
    // The load-bearing property. A denylist would pass this only for fields someone
    // thought of; every secret below sits under a key that does not exist today.
    const secrets = [
      "sk-ant-super-secret-key",
      "raj@example.com",
      "C:\\Users\\raj\\Documents\\taxes.xlsx",
      "the user said something confidential",
      "ghp_0123456789abcdef",
    ];
    const { value } = redact({
      type: "some_future_sdk_message",
      brand_new_field: secrets[0],
      nested: { deeper: { arbitrary: secrets[1] }, list: [secrets[2], { another: secrets[3] }] },
      arrayOfStrings: [secrets[4]],
    });

    const serialized = JSON.stringify(value);
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain(REDACTED);
    // The shape is preserved even though the content is gone.
    expect(value).toMatchObject({
      type: "some_future_sdk_message",
      nested: { list: [REDACTED, { another: REDACTED }] },
    });
  });

  it("keeps primitives that cannot carry prose", () => {
    const { value, report } = redact({ n: 42, b: true, z: null, empty: "" });
    expect(value).toEqual({ n: 42, b: true, z: null, empty: "" });
    expect(report.redactedStrings).toBe(0);
  });
});

describe("isVendorAuthoredText", () => {
  it("matches provider limit messaging", () => {
    // Both observed verbatim in real logs.
    expect(
      isVendorAuthoredText("You've hit your session limit · resets 1:50pm (America/Toronto)"),
    ).toBe(true);
    expect(
      isVendorAuthoredText(
        "You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit",
      ),
    ).toBe(true);
  });

  it("does not match prose that merely discusses rate limits", () => {
    // Regression on a real near-miss: a bare /rate limit/ pattern kept this repo's own
    // writing about the feature. A capture recorded while working on auto-resume would
    // then have committed paragraphs of conversation.
    expect(isVendorAuthoredText("the rate limit handling in classifyRateLimit")).toBe(false);
    expect(isVendorAuthoredText("218 real rate-limit events, only 2 are hard blocks")).toBe(false);
    expect(isVendorAuthoredText("Let me refactor the billing module")).toBe(false);
  });
});

describe("mergeReports", () => {
  it("sums per-message reports", () => {
    expect(
      mergeReports([
        { redactedStrings: 2, keptVendorStrings: 1 },
        { redactedStrings: 5, keptVendorStrings: 0 },
      ]),
    ).toEqual({ redactedStrings: 7, keptVendorStrings: 1 });
    expect(mergeReports([])).toEqual({ redactedStrings: 0, keptVendorStrings: 0 });
  });
});
