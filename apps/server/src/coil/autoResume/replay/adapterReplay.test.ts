// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { classifyRateLimit } from "../classifyRateLimit.ts";
import { eventsOfType, missingRecordedEventTypes, replayThroughAdapter } from "./adapterReplay.ts";
import type { Episode } from "./episode.ts";

function loadFixture(name: string): Episode {
  const file = NodePath.join(import.meta.dirname, "fixtures", `${name}.json`);
  return JSON.parse(NodeFS.readFileSync(file, "utf8")) as Episode;
}

describe("replayThroughAdapter — captured macOS hard block", () => {
  it.live("forwards the rate-limit payload through the real adapter intact", () =>
    Effect.gen(function* () {
      const episode = loadFixture("macos-hard-block-a");
      const result = yield* replayThroughAdapter(episode);

      const rateLimitEvents = eventsOfType(result, "account.rate-limits.updated");
      expect(rateLimitEvents.length).toBeGreaterThan(0);

      // The adapter must not reshape, filter or summarise the payload: auto-resume's whole
      // detection path reads these fields, and #118 turned on whether an overage-carrying
      // payload survived the trip.
      const payload = (rateLimitEvents[0] as { payload: { rateLimits: unknown } }).payload;
      expect(payload.rateLimits).toMatchObject({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          overageStatus: "rejected",
          overageDisabledReason: "org_level_disabled",
          rateLimitType: "five_hour",
          isUsingOverage: false,
        },
      });
    }),
  );

  it.live("produces a payload the real classifier reads as a rejection", () =>
    Effect.gen(function* () {
      // The end-to-end claim hypothesis 2 disputes: captured bytes -> real adapter ->
      // real classifier -> `rejected`. Asserting it here means a future SDK field rename
      // fails this test instead of silently disarming auto-resume in production.
      const episode = loadFixture("macos-hard-block-a");
      const result = yield* replayThroughAdapter(episode);
      const event = eventsOfType(result, "account.rate-limits.updated")[0];

      const verdict = classifyRateLimit(
        (event as { payload: { rateLimits: unknown } }).payload.rateLimits,
      );
      expect(verdict?.rejected).toBe(true);
      expect(verdict?.rateLimitType).toBe("five_hour");
      expect(verdict?.resetsAtMs).toBeGreaterThan(0);
    }),
  );

  it.live("reproduces every message-derived canonical event the capture recorded", () =>
    Effect.gen(function* () {
      // Differential check: the capture holds both halves of the adapter boundary, so the
      // adapter is compared against its own past behaviour. Compared as a type set — ids
      // and timestamps are regenerated per run, and transient types were never persisted
      // (see providerLog.ts).
      const episode = loadFixture("macos-hard-block-a");
      const result = yield* replayThroughAdapter(episode);

      expect(missingRecordedEventTypes(episode, result)).toEqual([]);
    }),
  );

  it.live("cannot reproduce callback-derived events, and says so", () =>
    Effect.gen(function* () {
      // Guards the exclusion above against becoming a silent catch-all. This capture
      // really does contain a user-input interaction, and replaying its messages really
      // cannot produce one — so the harness's blind spot is asserted, not assumed. If a
      // future adapter emits these from a message instead, this test fails and the
      // exclusion list should shrink.
      const episode = loadFixture("macos-hard-block-a");
      const recorded = new Set(episode.canonical.map((entry) => entry.type));
      expect(recorded.has("user-input.resolved")).toBe(true);

      const result = yield* replayThroughAdapter(episode);
      const produced = new Set(result.events.map((event) => event.type));
      expect(produced.has("user-input.resolved")).toBe(false);
    }),
  );
});
