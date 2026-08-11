import { assert, describe, it } from "@effect/vitest";

import {
  describeWindowsExitCode,
  explainWindowsFailure,
  findWindowsFatalStatuses,
  isTransientProcessStartFailure,
  WINDOWS_FATAL_STATUSES,
} from "./windows-exit-codes.mjs";

// Verbatim from issue #47. This is the only form the failure has ever actually been observed in,
// so it is the case every classifier here has to handle — the hex spelling appears nowhere.
const OBSERVED_LOG = `vp run: 0/3 cache hit (0%), 1 failed.

  [1] @t3tools/web#build:     vp build                                        OK
  [2] t3#build:               node scripts/cli.ts build                       OK
  [3] @t3tools/desktop#build: node scripts/build-preview-annotation-css.mjs   FAILED (exit code: -1073741502)
`;

describe("the status table", () => {
  it("keeps signed and unsigned forms of the same value in step", () => {
    for (const status of WINDOWS_FATAL_STATUSES) {
      assert.strictEqual(
        status.signed,
        status.unsigned - 2 ** 32,
        `${status.name}: signed and unsigned disagree`,
      );
      assert.isAbove(status.unsigned, 0x7fffffff, `${status.name} is not a fatal NTSTATUS`);
    }
  });

  it("gives every status a meaning and advice, since a bare code is the problem", () => {
    for (const status of WINDOWS_FATAL_STATUSES) {
      assert.isAbove(status.meaning.length, 0, `${status.name} has no meaning`);
      assert.isAbove(status.advice.length, 0, `${status.name} has no advice`);
    }
  });
});

describe("describeWindowsExitCode", () => {
  it("accepts every spelling the same status appears in", () => {
    const expected = "STATUS_DLL_INIT_FAILED";
    assert.strictEqual(describeWindowsExitCode(-1073741502)?.name, expected);
    assert.strictEqual(describeWindowsExitCode(0xc0000142)?.name, expected);
    assert.strictEqual(describeWindowsExitCode("-1073741502")?.name, expected);
    assert.strictEqual(describeWindowsExitCode("3221225794")?.name, expected);
    assert.strictEqual(describeWindowsExitCode("0xC0000142")?.name, expected);
    assert.strictEqual(describeWindowsExitCode("0xc0000142")?.name, expected);
    assert.strictEqual(describeWindowsExitCode("status_dll_init_failed")?.name, expected);
  });

  it("returns nothing for an ordinary exit code", () => {
    assert.isUndefined(describeWindowsExitCode(1));
    assert.isUndefined(describeWindowsExitCode(0));
    assert.isUndefined(describeWindowsExitCode("not a code"));
  });
});

describe("findWindowsFatalStatuses", () => {
  // The regression this file exists for. The release workflow's original classifier matched
  // `0xC0000142|0xC0000005|STATUS_DLL_INIT_FAILED|Access violation` — and the log below contains
  // none of them, so the retry it was written to trigger could never have fired.
  it("finds the status in the log exactly as vp printed it", () => {
    const found = findWindowsFatalStatuses(OBSERVED_LOG);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0]?.name, "STATUS_DLL_INIT_FAILED");
  });

  it("does not match a longer number that merely contains a status", () => {
    assert.deepStrictEqual(findWindowsFatalStatuses("build id 31073741502991"), []);
    assert.deepStrictEqual(findWindowsFatalStatuses("code -10737415021"), []);
  });

  it("finds nothing in an ordinary failure", () => {
    assert.deepStrictEqual(findWindowsFatalStatuses("FAILED (exit code: 1)"), []);
    assert.deepStrictEqual(findWindowsFatalStatuses(""), []);
  });

  it("finds every distinct status when a log carries more than one", () => {
    const names = findWindowsFatalStatuses(
      "first: -1073741502\nsecond: STATUS_HEAP_CORRUPTION",
    ).map((status) => status.name);
    assert.includeMembers(names, ["STATUS_DLL_INIT_FAILED", "STATUS_HEAP_CORRUPTION"]);
  });
});

describe("isTransientProcessStartFailure", () => {
  it("says retry for the observed failure", () => {
    assert.isTrue(isTransientProcessStartFailure(OBSERVED_LOG));
  });

  it("says do not retry for a crash that is a real bug", () => {
    assert.isFalse(isTransientProcessStartFailure("FAILED (exit code: -1073740940)"));
    assert.isFalse(isTransientProcessStartFailure("FAILED (exit code: -1073741701)"));
  });

  // "Every", not "any". A log carrying a heap corruption as well is not a flaky build, and
  // retrying it hides the corruption behind two more minutes of compute.
  it("refuses to call a mixed log transient", () => {
    assert.isFalse(
      isTransientProcessStartFailure("[1] exit code: -1073741502\n[2] exit code: -1073740940"),
    );
  });

  it("says nothing about a build that failed for an ordinary reason", () => {
    assert.isFalse(isTransientProcessStartFailure("FAILED (exit code: 1)"));
  });
});

describe("explainWindowsFailure", () => {
  it("names the status in all three forms, so any of them can be searched for", () => {
    const text = explainWindowsFailure(OBSERVED_LOG);
    assert.include(text, "STATUS_DLL_INIT_FAILED");
    assert.include(text, "0xC0000142");
    assert.include(text, "-1073741502");
  });

  it("says plainly whether a retry is warranted", () => {
    assert.include(explainWindowsFailure(OBSERVED_LOG), "Retryable");
    assert.include(explainWindowsFailure("exit code: -1073740940"), "NOT retryable");
  });

  it("stays quiet when there is nothing to explain", () => {
    assert.strictEqual(explainWindowsFailure("FAILED (exit code: 1)"), "");
  });
});
