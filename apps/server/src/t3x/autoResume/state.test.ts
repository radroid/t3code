// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodePath from "node:path";

import { type AutoResumeStoreShape, makeAutoResumeStore, type PendingResume } from "./state.ts";

const pending = (threadId: string, o: Partial<PendingResume> = {}): PendingResume => ({
  threadId,
  resumeAtMs: 1_000,
  reason: "five_hour",
  scheduledAtMs: 0,
  baseline: { newestUserMessageId: "m1", latestTurnId: "t1" },
  ...o,
});

const withStore = <A>(f: (store: AutoResumeStoreShape) => Effect.Effect<A>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3x-state-" });
    const path = NodePath.join(root, "state.json");
    const store = yield* makeAutoResumeStore(path);
    return yield* f(store);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);

describe("AutoResumeStore", () => {
  it("schedules, lists, and clears a pending resume", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.schedule(pending("thread-a"));
        let list = yield* store.listPending;
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0]!.threadId, "thread-a");

        yield* store.clearPending("thread-a");
        list = yield* store.listPending;
        assert.strictEqual(list.length, 0);
      }),
    ));

  it("keeps one pending per thread (schedule replaces)", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.schedule(pending("thread-a", { resumeAtMs: 1 }));
        yield* store.schedule(pending("thread-a", { resumeAtMs: 9999 }));
        const list = yield* store.listPending;
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0]!.resumeAtMs, 9999);
      }),
    ));

  it("recordFired clears pending and counts fired", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.schedule(pending("thread-a"));
        yield* store.recordFired("thread-a", 5_000);

        const record = yield* store.getThread("thread-a");
        assert.strictEqual(record.pending, null);

        const since0 = yield* store.countFiredSince("thread-a", 0);
        assert.strictEqual(since0, 1);
        const sinceFuture = yield* store.countFiredSince("thread-a", 6_000);
        assert.strictEqual(sinceFuture, 0);
      }),
    ));

  it("rehydrates persisted state from disk (survives a restart)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3x-state-" });
      const path = NodePath.join(root, "state.json");

      const store1 = yield* makeAutoResumeStore(path);
      yield* store1.schedule(pending("thread-a", { reason: "persisted" }));

      // A fresh store reading the same file should see the pending resume.
      const store2 = yield* makeAutoResumeStore(path);
      const list = yield* store2.listPending;
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0]!.reason, "persisted");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise));

  it("treats a missing state file as empty", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const list = yield* store.listPending;
        assert.strictEqual(list.length, 0);
      }),
    ));

  it("treats a corrupt or version-mismatched state file as empty (does not crash boot)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3x-state-" });

      const garbagePath = NodePath.join(root, "garbage.json");
      yield* fs.writeFileString(garbagePath, "{ not valid json ]");
      const s1 = yield* makeAutoResumeStore(garbagePath);
      assert.strictEqual((yield* s1.listPending).length, 0);

      const versionPath = NodePath.join(root, "v2.json");
      // A future schema version the current decoder does not accept (version is Literal(1)).
      yield* fs.writeFileString(versionPath, '{"version":2,"threads":{}}');
      const s2 = yield* makeAutoResumeStore(versionPath);
      assert.strictEqual((yield* s2.listPending).length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise));
});
