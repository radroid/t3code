import { describe, expect, it } from "vite-plus/test";

import {
  bodyType,
  canonicalRuntimeEvent,
  nativeSdkMessage,
  parseProviderLog,
  parseProviderLogLine,
  TRANSIENT_CANONICAL_EVENT_TYPES,
} from "./providerLog.ts";

// Both fixtures are byte-faithful reductions of lines observed in a real log on this
// machine (~/.t3/userdata/logs/provider/events.16cca1b0-…log). Field order, nesting and
// the `NTIVE`/`CANON` prefixes are copied from the file, not invented — the parser exists
// to read that exact format, so drifting from it would make these tests vacuous.
const NATIVE_LINE =
  '[2026-08-10T22:35:41.614Z] NTIVE: {"observedAt":"2026-08-10T22:35:41.614Z","event":' +
  '{"id":"25e7bbc0-42be-468a-b96a-9c276e968a60","kind":"notification","provider":"claudeAgent",' +
  '"createdAt":"2026-08-10T22:35:41.614Z","method":"claude/rate_limit_event",' +
  '"providerThreadId":"e3bfdbb3-2abf-4f89-8ddd-164bc1b23b05",' +
  '"turnId":"00cc6485-0247-4c0e-9b0b-fb6b88ba88eb","payload":{"type":"rate_limit_event",' +
  '"rate_limit_info":{"status":"allowed","resetsAt":1786402800,"rateLimitType":"five_hour",' +
  '"overageStatus":"rejected","overageDisabledReason":"org_level_disabled_until",' +
  '"isUsingOverage":false},"uuid":"25e7bbc0-42be-468a-b96a-9c276e968a60",' +
  '"session_id":"e3bfdbb3-2abf-4f89-8ddd-164bc1b23b05"}}}';

const CANONICAL_LINE =
  '[2026-08-10T23:12:41.841Z] CANON: {"type":"session.exited",' +
  '"eventId":"5fc601a3-ef7e-4efa-afd4-da4657aa1e3a","provider":"claudeAgent",' +
  '"createdAt":"2026-08-10T23:12:41.839Z","threadId":"16cca1b0-8132-4649-8021-ff46779aa5d7",' +
  '"payload":{"reason":"Session stopped","exitKind":"graceful"},"providerRefs":{},' +
  '"providerInstanceId":"claudeAgent"}';

describe("parseProviderLogLine", () => {
  it("reads a native line and exposes the raw SDK message at event.payload", () => {
    const entry = parseProviderLogLine(NATIVE_LINE, 1);
    expect(entry).toMatchObject({
      lineNumber: 1,
      observedAt: "2026-08-10T22:35:41.614Z",
      stream: "native",
    });

    const message = nativeSdkMessage(entry as never);
    expect(bodyType(message)).toBe("rate_limit_event");
    // The whole point of replaying natives: the overage fields survive intact.
    expect(message).toMatchObject({
      rate_limit_info: {
        status: "allowed",
        overageStatus: "rejected",
        overageDisabledReason: "org_level_disabled_until",
        rateLimitType: "five_hour",
        resetsAt: 1_786_402_800,
      },
    });
  });

  it("reads a canonical line as a ProviderRuntimeEvent with no envelope", () => {
    const entry = parseProviderLogLine(CANONICAL_LINE, 7);
    expect(entry).toMatchObject({ lineNumber: 7, stream: "canonical" });

    const event = canonicalRuntimeEvent(entry as never);
    expect(bodyType(event)).toBe("session.exited");
    expect(event).toMatchObject({
      threadId: "16cca1b0-8132-4649-8021-ff46779aa5d7",
      payload: { exitKind: "graceful", reason: "Session stopped" },
    });
  });

  it("recognizes the orchestration label", () => {
    const entry = parseProviderLogLine('[2026-08-10T22:35:41.614Z] ORCH: {"type":"x"}', 1);
    expect(entry).toMatchObject({ stream: "orchestration" });
  });

  it("reports rather than throws on the ways a rotated log breaks", () => {
    // A crash or rotation can sever a line mid-JSON; a stray line can carry no prefix at
    // all. Either must degrade to a report, because a capture tool that throws on one bad
    // line cannot read the log from the incident that motivated it.
    expect(parseProviderLogLine('[2026-08-10T22:35:41.614Z] NTIVE: {"trunc', 3)).toEqual({
      lineNumber: 3,
      reason: "bad-json",
    });
    expect(parseProviderLogLine("not a log line at all", 4)).toEqual({
      lineNumber: 4,
      reason: "no-prefix",
    });
    expect(parseProviderLogLine("[2026-08-10T22:35:41.614Z] WAT: {}", 5)).toEqual({
      lineNumber: 5,
      reason: "unknown-label",
    });
  });
});

describe("parseProviderLog", () => {
  it("keeps good entries, reports bad ones, and numbers lines as the file does", () => {
    const contents = [NATIVE_LINE, "", "garbage", CANONICAL_LINE].join("\n");
    const result = parseProviderLog(contents);

    expect(result.entries.map((e) => e.stream)).toEqual(["native", "canonical"]);
    // Blank lines are skipped without consuming a number: garbage is line 3, CANON line 4.
    expect(result.malformed).toEqual([{ lineNumber: 3, reason: "no-prefix" }]);
    expect(result.entries[1]?.lineNumber).toBe(4);
  });

  it("tolerates a file with no trailing newline and an empty file", () => {
    expect(parseProviderLog(NATIVE_LINE).entries).toHaveLength(1);
    expect(parseProviderLog("")).toEqual({ entries: [], malformed: [] });
  });
});

describe("TRANSIENT_CANONICAL_EVENT_TYPES", () => {
  it("mirrors the upstream drop list so a differential replay excludes the right types", () => {
    // Kept in lockstep with transientCanonicalEventTypes (EventNdjsonLogger.ts:39-47). If
    // upstream adds a type here, a replay diff would otherwise report it as "the adapter
    // produced an event the capture lacks" — a false positive on every capture.
    expect([...TRANSIENT_CANONICAL_EVENT_TYPES].sort()).toEqual([
      "content.delta",
      "hook.progress",
      "item.updated",
      "task.progress",
      "thread.realtime.audio.delta",
      "tool.progress",
      "turn.proposed.delta",
    ]);
  });

  it("does not drop any event auto-resume depends on", () => {
    for (const type of ["account.rate-limits.updated", "session.exited", "turn.completed"]) {
      expect(TRANSIENT_CANONICAL_EVENT_TYPES.has(type)).toBe(false);
    }
  });
});
