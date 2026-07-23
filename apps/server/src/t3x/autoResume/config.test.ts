// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodePath from "node:path";

import {
  DEFAULT_BACKOFF_LADDER_MS,
  DEFAULT_RESUME_PROMPT,
  RESUME_PROMPT_RELATIVE_PATH,
  backoffDelayMs,
  resolveConfig,
  resolveResumePrompt,
} from "./config.ts";

describe("resolveConfig", () => {
  it("uses safe defaults for an empty env", () => {
    const c = resolveConfig({});
    assert.strictEqual(c.enabled, true);
    assert.strictEqual(c.pollMs, 30_000);
    assert.strictEqual(c.maxResumesPer24h, 10);
    assert.strictEqual(c.safetyMarginMs, 60_000);
    assert.deepStrictEqual([...c.backoffLadderMs], [...DEFAULT_BACKOFF_LADDER_MS]);
  });

  it("parses overrides and ignores invalid values", () => {
    const c = resolveConfig({
      T3X_AUTO_RESUME_ENABLED: "false",
      T3X_AUTO_RESUME_POLL_MS: "5000",
      T3X_AUTO_RESUME_MAX_PER_24H: "-3", // invalid -> default
      T3X_AUTO_RESUME_SAFETY_MARGIN_MS: "0", // invalid -> default
      T3X_AUTO_RESUME_BACKOFF_MS: "1000, 2000 ,x",
    });
    assert.strictEqual(c.enabled, false);
    assert.strictEqual(c.pollMs, 5000);
    assert.strictEqual(c.maxResumesPer24h, 10);
    assert.strictEqual(c.safetyMarginMs, 60_000);
    assert.deepStrictEqual([...c.backoffLadderMs], [1000, 2000]);
  });
});

describe("backoffDelayMs", () => {
  it("clamps the attempt index into the ladder", () => {
    const ladder = [10, 20, 30];
    assert.strictEqual(backoffDelayMs(ladder, 0), 10);
    assert.strictEqual(backoffDelayMs(ladder, 1), 20);
    assert.strictEqual(backoffDelayMs(ladder, 99), 30);
    assert.strictEqual(backoffDelayMs(ladder, -1), 10);
  });
});

describe("resolveResumePrompt", () => {
  it("prefers a per-thread override", () =>
    Effect.gen(function* () {
      const result = yield* resolveResumePrompt({
        workspaceRoot: null,
        threadOverride: "  do the thing  ",
      });
      assert.strictEqual(result, "do the thing");
    }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));

  it("reads the project resume-prompt file when present", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3x-prompt-" });
      const promptPath = NodePath.join(root, RESUME_PROMPT_RELATIVE_PATH);
      yield* fs.makeDirectory(NodePath.dirname(promptPath), { recursive: true });
      yield* fs.writeFileString(promptPath, "read the latest iter log and continue\n");
      const result = yield* resolveResumePrompt({ workspaceRoot: root });
      assert.strictEqual(result, "read the latest iter log and continue");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise));

  it("falls back to the default when no override and no file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3x-prompt-" });
      const result = yield* resolveResumePrompt({ workspaceRoot: root });
      assert.strictEqual(result, DEFAULT_RESUME_PROMPT);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise));
});
