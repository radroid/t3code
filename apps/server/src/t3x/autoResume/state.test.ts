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

  it("keeps a present-but-unreadable state file intact and runs in-memory (no clobber)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3x-state-" });
      // A directory at the state path is *present* but unreadable as a file (EISDIR). The
      // store must not mistake this for a fresh/empty store and must not overwrite it —
      // otherwise a transient read error on a real file would clobber valid durable state.
      const dirPath = NodePath.join(root, "state-is-a-dir");
      yield* fs.makeDirectory(dirPath);

      const store = yield* makeAutoResumeStore(dirPath);
      // Boot did not crash; scheduling still works in-memory this session.
      yield* store.schedule(pending("thread-a"));
      assert.strictEqual((yield* store.listPending).length, 1);

      // The existing path was preserved (persistence suppressed → never clobbered).
      const stat = yield* fs.stat(dirPath);
      assert.strictEqual(stat.type, "Directory");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise));

  it("defaults enabled to true for a thread that has no record yet", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const record = yield* store.getThread("never-seen");
        assert.strictEqual(record.enabled, true);
        assert.strictEqual(record.overridePrompt, null);
      }),
    ));

  // `threads` is a plain object, so these ids resolve on Object.prototype and are truthy.
  // A `?? EMPTY_RECORD` lookup therefore returns a prototype method typed as a
  // ThreadRecord: reads blow up on `record.pending`, and writes persist a record with no
  // required keys, which fails the whole-file decode on the next boot and wipes every
  // pending resume. The HTTP route takes threadId straight from the caller, so this is
  // reachable input, not a curiosity.
  for (const hostile of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    it(`treats the prototype-chain threadId "${hostile}" as an absent record`, () =>
      withStore((store) =>
        Effect.gen(function* () {
          const record = yield* store.getThread(hostile);
          assert.strictEqual(record.enabled, true);
          assert.strictEqual(record.pending, null, "must be null, not undefined");
          assert.strictEqual(record.overridePrompt, null);
          assert.deepStrictEqual([...record.firedAtMs], []);
        }),
      ));
  }

  it("a write under a prototype-chain threadId does not corrupt other threads' state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3x-state-" });
      const path = NodePath.join(root, "state.json");

      const store1 = yield* makeAutoResumeStore(path);
      yield* store1.schedule(pending("real-thread"));
      yield* store1.recordFired("other-thread", 42);

      // The hostile write must persist a well-formed record like any other.
      yield* store1.setEnabled("__proto__", false);
      yield* store1.setOverridePrompt("constructor", "x");

      // Everything must still decode after a restart — the failure mode this guards is a
      // whole-file decode failure collapsing to EMPTY_STATE.
      const store2 = yield* makeAutoResumeStore(path);
      assert.strictEqual(
        (yield* store2.listPending).length,
        1,
        "the real thread's pending resume must survive",
      );
      assert.strictEqual(
        yield* store2.countFiredSince("other-thread", 0),
        1,
        "fired history behind the 24h cap must survive",
      );
      assert.strictEqual((yield* store2.getThread("__proto__")).enabled, false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise));

  it("setEnabled and setOverridePrompt round-trip and survive a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3x-state-" });
      const path = NodePath.join(root, "state.json");

      const store1 = yield* makeAutoResumeStore(path);
      yield* store1.setEnabled("thread-a", false);
      yield* store1.setOverridePrompt("thread-a", "keep going");

      const before = yield* store1.getThread("thread-a");
      assert.strictEqual(before.enabled, false);
      assert.strictEqual(before.overridePrompt, "keep going");

      const store2 = yield* makeAutoResumeStore(path);
      const after = yield* store2.getThread("thread-a");
      assert.strictEqual(after.enabled, false);
      assert.strictEqual(after.overridePrompt, "keep going");

      // Clearing the override falls back to the configured default.
      yield* store2.setOverridePrompt("thread-a", null);
      assert.strictEqual((yield* store2.getThread("thread-a")).overridePrompt, null);
      // …and toggling back on does not disturb the override.
      yield* store2.setEnabled("thread-a", true);
      assert.strictEqual((yield* store2.getThread("thread-a")).enabled, true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise));

  it("decodes a pre-`enabled` state file as enabled without dropping pending or fired history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3x-state-" });
      const path = NodePath.join(root, "legacy.json");

      // Exactly the shape written before `enabled` existed: no `enabled` key at all.
      // `enabled` is a *required* key on the Type side, so if it were not declared with a
      // decoding default the whole-file decode would fail — and the boot path turns a decode
      // failure into EMPTY_STATE, silently destroying the pending resume + fired history
      // below. This test is the regression guard for that data-loss path.
      // Written as a literal so the test pins the exact historical on-disk format
      // rather than whatever the current encoder happens to produce.
      yield* fs.writeFileString(
        path,
        `{"version":1,"threads":{"thread-a":{` +
          `"pending":{"threadId":"thread-a","resumeAtMs":4242,"reason":"five_hour",` +
          `"scheduledAtMs":7,"baseline":{"newestUserMessageId":"m1","latestTurnId":"t1"}},` +
          `"firedAtMs":[111,222],"overridePrompt":"legacy text"}}}`,
      );

      const store = yield* makeAutoResumeStore(path);

      const record = yield* store.getThread("thread-a");
      assert.strictEqual(record.enabled, true, "missing `enabled` must decode as on");
      assert.strictEqual(record.overridePrompt, "legacy text");

      // The rest of the record must survive intact (i.e. the file did not collapse to empty).
      const list = yield* store.listPending;
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0]!.resumeAtMs, 4_242);
      assert.strictEqual(yield* store.countFiredSince("thread-a", 0), 2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise));
});
