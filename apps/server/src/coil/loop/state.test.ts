// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodePath from "node:path";

import {
  type Blocker,
  DEFAULT_GLOBAL_SETTINGS,
  EMPTY_RECORD,
  LoopGlobalSettings,
  type LoopRecord,
  LoopRecord as LoopRecordSchema,
  type LoopStoreShape,
  makeLoopStore,
} from "./state.ts";

const withStore = <A>(f: (store: LoopStoreShape) => Effect.Effect<A>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "coil-loop-" });
    const store = yield* makeLoopStore(NodePath.join(root, "coil-loop.json"));
    return yield* f(store);
  }).pipe(Effect.scoped, Effect.orDie, Effect.provide(NodeServices.layer), Effect.runPromise);

const withTempDir = <A, E>(
  f: (root: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "coil-loop-" });
    return yield* f(root);
  }).pipe(Effect.scoped, Effect.orDie, Effect.provide(NodeServices.layer), Effect.runPromise);

const arm = (threadId: string, overrides: Record<string, unknown> = {}) => ({
  threadId,
  armedAtMs: 1_000,
  deadlineAtMs: 9_000_000,
  maxCheckIns: 6,
  ...overrides,
});

const blocker = (id: string, overrides: Partial<Blocker> = {}): Blocker => ({
  id,
  raisedAtMs: 5_000,
  question: "Should I take the migration or the shim?",
  options: [{ label: "migration", description: "slower, correct" }],
  context: "packages/contracts/src/settings.ts",
  answeredAtMs: null,
  answer: null,
  deliveredToAgent: false,
  ...overrides,
});

/**
 * A record with every field set to something that is NOT its decoding default, so a test
 * that drops one field can prove the rest survived rather than the whole file collapsing.
 */
const FULL_RECORD: LoopRecord = {
  armed: true,
  armedAtMs: 1_700_000_000_000,
  goal: "land the sync",
  maxCheckIns: 6,
  checkInsUsed: 2,
  deadlineAtMs: 1_700_028_800_000,
  idleMs: 11 * 60_000,
  busyIdleMs: 33 * 60_000,
  crons: {
    recordedAtMs: 1_700_000_100_000,
    entries: [
      {
        id: "cron-1",
        schedule: "*/30 * * * *",
        recurring: true,
        prompt: "keep going",
        nextFireAtMs: 1_700_001_800_000,
      },
    ],
  },
  degraded: "gate_off",
  userInputs: [
    {
      requestId: "req-1",
      raisedAtMs: 1_700_000_200_000,
      dialogKind: "resume_return",
      question: "Resume this session?",
      resolution: "voided",
      resolvedAtMs: 1_700_000_300_000,
    },
  ],
  lastCheckIn: { firedAtMs: 1_700_000_400_000, createdAtIso: "2026-09-02T01:00:00.000Z" },
  checkIns: [
    {
      n: 1,
      firedAtMs: 1_700_000_400_000,
      createdAtIso: "2026-09-02T01:00:00.000Z",
      activityCursor: "act-42",
      outcome: "productive",
    },
  ],
  strikes: 1,
  rateLimitedUntilMs: 1_700_005_000_000,
  pinnedByLoop: true,
  stopped: { reason: "stalled", atMs: 1_700_006_000_000, detail: "two quiet check-ins" },
  overridePrompt: "resume the migration",
  blockers: [
    blocker("b-1", { answeredAtMs: 1_700_007_000_000, answer: "shim", deliveredToAgent: true }),
  ],
  loopDoneAtMs: 1_700_008_000_000,
  loopDoneReason: "migration landed",
};

// These two pin the exact on-disk bytes rather than round-tripping through the encoder, so
// the cases below assert what a real file written by another build looks like.
const stateFileWith = (record: Record<string, unknown>) =>
  JSON.stringify({ version: 1, threads: { "thread-a": record } });

const globalFileWith = (global: Record<string, unknown>) =>
  JSON.stringify({ version: 1, global, threads: {} });

describe("LoopStore — rehydrate", () => {
  it("59 — a missing state file reads as empty and never throws", () =>
    withStore((store) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* store.listArmed, []);
        assert.deepStrictEqual(yield* store.getGlobal, DEFAULT_GLOBAL_SETTINGS);
        assert.deepStrictEqual(yield* store.getThread("never-seen"), EMPTY_RECORD);
      }),
    ));

  it("60 — a record round-trips through disk unchanged", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const path = NodePath.join(root, "coil-loop.json");
        const store1 = yield* makeLoopStore(path);
        yield* store1.update("thread-a", () => FULL_RECORD);

        const store2 = yield* makeLoopStore(path);
        assert.deepStrictEqual(yield* store2.getThread("thread-a"), FULL_RECORD);
      }),
    ));

  it("62 — a corrupt file reads as empty rather than throwing at boot", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const garbage = NodePath.join(root, "garbage.json");
        yield* fs.writeFileString(garbage, '{"version":1,"threads":{ truncated');
        const store = yield* makeLoopStore(garbage);
        assert.deepStrictEqual(yield* store.listArmed, []);
      }),
    ));

  it("62 — a future schema version reads as empty rather than throwing at boot", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = NodePath.join(root, "v2.json");
        yield* fs.writeFileString(path, '{"version":2,"threads":{}}');
        const store = yield* makeLoopStore(path);
        assert.deepStrictEqual(yield* store.listArmed, []);
      }),
    ));

  it("62 — a present-but-unreadable file is preserved and the session runs in memory", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // A directory at the state path is *present* but unreadable as a file (EISDIR). The
        // store must not mistake that for a fresh store: overwriting it would be the
        // transient-I/O-error path silently disarming every loop on the machine.
        const dirPath = NodePath.join(root, "state-is-a-dir");
        yield* fs.makeDirectory(dirPath);

        const store = yield* makeLoopStore(dirPath);
        yield* store.arm(arm("thread-a"));
        assert.strictEqual((yield* store.listArmed).length, 1);

        assert.strictEqual((yield* fs.stat(dirPath)).type, "Directory");
      }),
    ));

  it("63 — unknown keys from a newer build are tolerated", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = NodePath.join(root, "forward.json");
        // `workSource` lands with the maintainer loop (#44); a build that predates it must
        // not choke on a file a newer build wrote.
        yield* fs.writeFileString(
          path,
          stateFileWith({ ...FULL_RECORD, workSource: "issue-queue" }),
        );
        const store = yield* makeLoopStore(path);
        assert.strictEqual((yield* store.getThread("thread-a")).goal, "land the sync");
      }),
    ));
});

// The highest-severity footgun in the module: a missing REQUIRED key fails the whole-file
// decode, the boot path turns that into EMPTY_STATE, and every armed loop on the machine is
// silently disarmed. This suite is schema-reflective on purpose — adding a field without a
// decoding default fails it without anyone remembering to write a case.
describe("LoopStore — fail-closed decoding defaults", () => {
  for (const field of Object.keys(LoopRecordSchema.fields)) {
    it(`61 — a record written without \`${field}\` still decodes, and the rest survives`, () =>
      withTempDir((root) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = NodePath.join(root, `missing-${field}.json`);
          const partial: Record<string, unknown> = { ...FULL_RECORD };
          delete partial[field];
          yield* fs.writeFileString(path, stateFileWith(partial));

          const store = yield* makeLoopStore(path);
          const record = yield* store.getThread("thread-a");
          const witness = field === "armedAtMs" ? "maxCheckIns" : "armedAtMs";
          assert.deepStrictEqual(
            record[witness],
            FULL_RECORD[witness],
            "the file must not have collapsed to EMPTY_STATE",
          );
        }),
      ));
  }

  for (const field of Object.keys(LoopGlobalSettings.fields)) {
    it(`61 — global settings written without \`${field}\` still decode`, () =>
      withTempDir((root) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = NodePath.join(root, `missing-global-${field}.json`);
          const partial: Record<string, unknown> = {
            ...DEFAULT_GLOBAL_SETTINGS,
            maxArmedThreads: 7,
            defaultMaxCheckIns: 9,
          };
          delete partial[field];
          yield* fs.writeFileString(path, globalFileWith(partial));

          const store = yield* makeLoopStore(path);
          const global = yield* store.getGlobal;
          // The witness is never the deleted field, so a surviving non-default value proves
          // the whole file decoded rather than collapsing to EMPTY_STATE.
          const witness = field === "maxArmedThreads" ? "defaultMaxCheckIns" : "maxArmedThreads";
          assert.strictEqual(global[witness], field === "maxArmedThreads" ? 9 : 7);
        }),
      ));
  }

  it("61 — an entirely absent thread record decodes to every default", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = NodePath.join(root, "bare.json");
        yield* fs.writeFileString(path, stateFileWith({}));
        const store = yield* makeLoopStore(path);
        assert.deepStrictEqual(yield* store.getThread("thread-a"), EMPTY_RECORD);
      }),
    ));

  it("61b — every default is the fail-closed reading, not merely present", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = NodePath.join(root, "fail-closed.json");
        // The top level itself is missing `global` and the record is empty: exactly what a
        // truncated write or an older build leaves behind.
        yield* fs.writeFileString(path, stateFileWith({}));
        const store = yield* makeLoopStore(path);

        const global = yield* store.getGlobal;
        assert.strictEqual(global.enabled, false, "the master toggle must default OFF");

        const record = yield* store.getThread("thread-a");
        assert.strictEqual(record.armed, false, "nothing is supervised implicitly");
        // 0 is always <= now, so the stop sweep ends the run on its first evaluation. A
        // default meaning "unbounded" would turn one truncated write into an unbounded spend.
        assert.strictEqual(record.deadlineAtMs, 0, "an unknown deadline is already spent");
        assert.strictEqual(record.maxCheckIns, 0, "an unknown budget is already spent");
        assert.strictEqual(record.crons, null, "never observed, which is not the same as empty");
        assert.strictEqual(record.pinnedByLoop, false, "never unpin a pin the loop did not make");
        assert.strictEqual(record.stopped, null);
        assert.deepStrictEqual([...record.blockers], []);
      }),
    ));
});

describe("LoopStore — arming", () => {
  it("59 — arming seeds the thresholds from the global settings", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.setGlobal({ defaultIdleMs: 7 * 60_000, defaultBusyIdleMs: 21 * 60_000 });
        const record = yield* store.arm(arm("thread-a", { goal: "ship it" }));
        assert.strictEqual(record.armed, true);
        assert.strictEqual(record.idleMs, 7 * 60_000);
        assert.strictEqual(record.busyIdleMs, 21 * 60_000);
        assert.strictEqual(record.goal, "ship it");
        assert.deepStrictEqual(yield* store.listArmed, [{ threadId: "thread-a", record }]);
      }),
    ));

  it("59 — an explicit threshold wins over the global default", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const record = yield* store.arm(arm("thread-a", { idleMs: 60_000 }));
        assert.strictEqual(record.idleMs, 60_000);
      }),
    ));

  it("59 — disarm keeps the budget so a re-arm is a deliberate act, not a repair", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.arm(arm("thread-a"));
        yield* store.recordCheckIn({
          threadId: "thread-a",
          firedAtMs: 2_000,
          createdAtIso: "2026-09-02T01:00:00.000Z",
          activityCursor: "act-1",
        });
        yield* store.disarm("thread-a");

        const record = yield* store.getThread("thread-a");
        assert.strictEqual(record.armed, false);
        assert.strictEqual(record.checkInsUsed, 1, "a takeover is not a budget reset");
        assert.strictEqual(record.stopped, null, "guard 4's disarm writes no terminal state");
      }),
    ));

  it("59 — a terminal state is sticky and only a re-arm clears it", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.arm(arm("thread-a"));
        yield* store.recordCheckIn({
          threadId: "thread-a",
          firedAtMs: 2_000,
          createdAtIso: "2026-09-02T01:00:00.000Z",
          activityCursor: "act-1",
        });
        yield* store.update("thread-a", (record) => ({ ...record, strikes: 2 }));
        yield* store.stop("thread-a", { reason: "spent", atMs: 3_000, detail: "budget" });

        const stopped = yield* store.getThread("thread-a");
        assert.strictEqual(stopped.armed, false);
        assert.strictEqual(stopped.stopped?.reason, "spent");
        assert.deepStrictEqual(yield* store.listArmed, []);

        const rearmed = yield* store.arm(arm("thread-a", { armedAtMs: 5_000 }));
        assert.strictEqual(rearmed.stopped, null);
        assert.strictEqual(rearmed.armed, true);
        assert.strictEqual(rearmed.armedAtMs, 5_000);
        assert.strictEqual(rearmed.checkInsUsed, 0);
        assert.strictEqual(rearmed.strikes, 0);
        assert.deepStrictEqual([...rearmed.checkIns], []);
      }),
    ));

  it("59 — a re-arm keeps the facts that outlive a run", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.arm(arm("thread-a"));
        yield* store.setRateLimitedUntil("thread-a", 8_000);
        yield* store.setCrons("thread-a", {
          recordedAtMs: 100,
          entries: [
            {
              id: "c1",
              schedule: "0 * * * *",
              recurring: true,
              prompt: "p",
              nextFireAtMs: 900,
            },
          ],
        });
        yield* store.addBlocker("thread-a", blocker("b-1"));
        yield* store.recordUserInput("thread-a", {
          requestId: "req-1",
          raisedAtMs: 200,
          dialogKind: null,
          question: "q",
          resolution: null,
          resolvedAtMs: null,
        });

        const rearmed = yield* store.arm(arm("thread-a", { armedAtMs: 5_000 }));
        // An account limit outlives the run, the provider's cron table belongs to the
        // session, and an answer banked before the re-arm is still owed to the agent.
        assert.strictEqual(rearmed.rateLimitedUntilMs, 8_000);
        assert.strictEqual(rearmed.crons?.entries.length, 1);
        assert.strictEqual(rearmed.blockers.length, 1);
        assert.strictEqual(rearmed.userInputs.length, 1);
      }),
    ));

  it("59 — global settings round-trip and survive a restart", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const path = NodePath.join(root, "coil-loop.json");
        const store1 = yield* makeLoopStore(path);
        const updated = yield* store1.setGlobal({ enabled: true, maxArmedThreads: 5 });
        assert.strictEqual(updated.enabled, true);
        assert.strictEqual(updated.defaultMaxCheckIns, 6, "an unset key keeps its default");

        const store2 = yield* makeLoopStore(path);
        const global = yield* store2.getGlobal;
        assert.strictEqual(global.enabled, true);
        assert.strictEqual(global.maxArmedThreads, 5);
      }),
    ));
});

describe("LoopStore — check-ins and durability", () => {
  it("67 — recordCheckIn is on disk before it returns, so a reservation precedes dispatch", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = NodePath.join(root, "coil-loop.json");
        const store = yield* makeLoopStore(path);
        yield* store.arm(arm("thread-a"));

        const row = yield* store.recordCheckIn({
          threadId: "thread-a",
          firedAtMs: 4_000,
          createdAtIso: "2026-09-02T01:00:00.000Z",
          activityCursor: "act-7",
        });
        assert.strictEqual(row.n, 1);
        assert.strictEqual(row.outcome, "unknown");

        // Read the raw bytes: a provider that cannot spawn must burn budget, not tight-loop.
        const contents = yield* fs.readFileString(path);
        assert.ok(contents.includes('"checkInsUsed":1'), contents);
        assert.ok(contents.includes('"activityCursor":"act-7"'), contents);
      }),
    ));

  it("67 — the ledger records the cursor and fire time at nudge time", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.arm(arm("thread-a"));
        yield* store.recordCheckIn({
          threadId: "thread-a",
          firedAtMs: 4_000,
          createdAtIso: "2026-09-02T01:00:00.000Z",
          activityCursor: "act-1",
        });
        yield* store.recordCheckIn({
          threadId: "thread-a",
          firedAtMs: 5_000,
          createdAtIso: "2026-09-02T02:00:00.000Z",
          activityCursor: "act-2",
        });

        const record = yield* store.getThread("thread-a");
        assert.strictEqual(record.checkInsUsed, 2);
        assert.deepStrictEqual(
          record.checkIns.map((row) => [row.n, row.activityCursor]),
          [
            [1, "act-1"],
            [2, "act-2"],
          ],
        );
        assert.deepStrictEqual(record.lastCheckIn, {
          firedAtMs: 5_000,
          createdAtIso: "2026-09-02T02:00:00.000Z",
        });
      }),
    ));

  it("60 — a rate limit is durable and survives a restart", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const path = NodePath.join(root, "coil-loop.json");
        const store1 = yield* makeLoopStore(path);
        yield* store1.setRateLimitedUntil("thread-a", 1_700_000_000_000);

        const store2 = yield* makeLoopStore(path);
        assert.strictEqual(
          (yield* store2.getThread("thread-a")).rateLimitedUntilMs,
          1_700_000_000_000,
        );
      }),
    ));

  it("64 — concurrent mutations serialize with no lost update", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.arm(arm("thread-a"));
        yield* Effect.all(
          Array.from({ length: 64 }, () =>
            store.update("thread-a", (record) => ({ ...record, strikes: record.strikes + 1 })),
          ),
          { concurrency: "unbounded" },
        );
        assert.strictEqual((yield* store.getThread("thread-a")).strikes, 64);
      }),
    ));

  it("65 — the file is never observable half-written", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = NodePath.join(root, "coil-loop.json");
        const store = yield* makeLoopStore(path);
        yield* store.arm(arm("thread-a"));

        // Read the file repeatedly while it is being rewritten. The write is a rename over a
        // fully-written temp file, so every read that finds a file must find a whole one.
        const reads: Array<string> = [];
        const reader = Effect.forEach(
          Array.from({ length: 200 }, (_, index) => index),
          () =>
            fs.readFileString(path).pipe(
              Effect.map((contents) => {
                reads.push(contents);
              }),
              Effect.orElseSucceed(() => undefined),
              Effect.flatMap(() => Effect.yieldNow),
            ),
          { discard: true },
        );
        const writer = Effect.all(
          Array.from({ length: 100 }, (_, index) =>
            store.update("thread-a", (record) => ({ ...record, strikes: index })),
          ),
          { concurrency: "unbounded" },
        );

        yield* Effect.all([reader, writer], { concurrency: "unbounded" });

        assert.ok(reads.length > 0, "the reader never observed the file at all");
        for (const contents of reads) {
          assert.ok(
            contents.endsWith("}\n") && contents.startsWith('{"version":1'),
            `observed a partial document: ${contents.slice(0, 80)}`,
          );
        }
      }),
    ));

  it("66 — a failed persist does not fail the mutation, and memory stays authoritative", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = NodePath.join(root, "nested", "coil-loop.json");
        const store = yield* makeLoopStore(path);

        // Put a regular file where the state directory needs to be, so every subsequent
        // write fails at `makeDirectory`.
        yield* fs.writeFileString(NodePath.join(root, "nested"), "not a directory");

        yield* store.arm(arm("thread-a"));
        const record = yield* store.getThread("thread-a");
        assert.strictEqual(record.armed, true, "the mutation must still succeed in memory");
        assert.strictEqual(
          (yield* fs.stat(NodePath.join(root, "nested"))).type,
          "File",
          "nothing on disk was clobbered",
        );
        // And the write really did fail, so this is not a vacuous assertion: a restart from
        // the same path finds nothing, rather than a state file claiming a persist that
        // never happened.
        const restarted = yield* makeLoopStore(path);
        assert.deepStrictEqual([...(yield* restarted.listArmed)], []);
      }),
    ));
});

describe("LoopStore — hostile thread ids", () => {
  // `threads` is a plain object, so these ids resolve on Object.prototype and are truthy. A
  // `?? EMPTY_RECORD` lookup would hand back a prototype method typed as a LoopRecord: reads
  // blow up, and writes persist a record with no keys, which fails the whole-file decode on
  // the next boot and disarms every loop. The HTTP route takes threadId straight from the
  // caller, so this is reachable input.
  for (const hostile of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    it(`68 — the prototype-chain threadId "${hostile}" reads as an absent record`, () =>
      withStore((store) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* store.getThread(hostile), EMPTY_RECORD);
        }),
      ));
  }

  it("68 — a write under a prototype-chain threadId does not corrupt other threads", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const path = NodePath.join(root, "coil-loop.json");
        const store1 = yield* makeLoopStore(path);
        yield* store1.arm(arm("real-thread"));
        yield* store1.arm(arm("__proto__", { armedAtMs: 42 }));
        yield* store1.setOverridePrompt("constructor", "x");

        const store2 = yield* makeLoopStore(path);
        assert.strictEqual((yield* store2.listArmed).length, 2);
        assert.strictEqual((yield* store2.getThread("__proto__")).armedAtMs, 42);
        assert.strictEqual((yield* store2.getThread("constructor")).overridePrompt, "x");
        assert.strictEqual((yield* store2.getThread("real-thread")).armed, true);
      }),
    ));
});

describe("LoopStore — recorded user inputs", () => {
  const requested = (requestId: string, dialogKind: string | null) => ({
    requestId,
    raisedAtMs: 1_000,
    dialogKind,
    question: "Which branch?",
    resolution: null,
    resolvedAtMs: null,
  });

  it("60 — a requested input is recorded once, with its dialog kind", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.recordUserInput("thread-a", requested("req-1", "resume_return"));
        yield* store.recordUserInput("thread-a", requested("req-1", "resume_return"));
        const record = yield* store.getThread("thread-a");
        assert.strictEqual(record.userInputs.length, 1);
        assert.strictEqual(record.userInputs[0]?.dialogKind, "resume_return");
      }),
    ));

  it("60 — a voided input is distinguishable from an answered one", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.recordUserInput("thread-a", requested("req-1", null));
        yield* store.recordUserInput("thread-a", requested("req-2", null));
        yield* store.resolveUserInput("thread-a", "req-1", "answered", 2_000);
        yield* store.resolveUserInput("thread-a", "req-2", "voided", 2_500);

        const record = yield* store.getThread("thread-a");
        assert.deepStrictEqual(
          record.userInputs.map((entry) => [entry.requestId, entry.resolution]),
          [
            ["req-1", "answered"],
            ["req-2", "voided"],
          ],
        );
      }),
    ));

  it("60 — a teardown void cannot overwrite a human's answer", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.recordUserInput("thread-a", requested("req-1", null));
        yield* store.resolveUserInput("thread-a", "req-1", "answered", 2_000);
        yield* store.resolveUserInput("thread-a", "req-1", "voided", 3_000);

        const record = yield* store.getThread("thread-a");
        assert.strictEqual(record.userInputs[0]?.resolution, "answered");
        assert.strictEqual(record.userInputs[0]?.resolvedAtMs, 2_000);
      }),
    ));
});

describe("LoopStore — crons and degradation", () => {
  it("60 — `null` and an empty entry list are different facts", () =>
    withStore((store) =>
      Effect.gen(function* () {
        assert.strictEqual((yield* store.getThread("thread-a")).crons, null);
        yield* store.setCrons("thread-a", { recordedAtMs: 10, entries: [] });
        const record = yield* store.getThread("thread-a");
        assert.notStrictEqual(record.crons, null, "observed-and-empty is not never-observed");
        assert.deepStrictEqual([...(record.crons?.entries ?? [])], []);
      }),
    ));

  it("60 — a degraded state is set and cleared only explicitly", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.setDegraded("thread-a", "gate_off");
        assert.strictEqual((yield* store.getThread("thread-a")).degraded, "gate_off");
        yield* store.setCrons("thread-a", { recordedAtMs: 10, entries: [] });
        assert.strictEqual(
          (yield* store.getThread("thread-a")).degraded,
          "gate_off",
          "an unrelated write must not clear it",
        );
        yield* store.setDegraded("thread-a", null);
        assert.strictEqual((yield* store.getThread("thread-a")).degraded, null);
      }),
    ));
});

describe("LoopStore — blockers", () => {
  it("69 — add, answer, list-unanswered and the delivered flip all persist", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const path = NodePath.join(root, "coil-loop.json");
        const store1 = yield* makeLoopStore(path);
        yield* store1.addBlocker("thread-a", blocker("b-1"));
        yield* store1.addBlocker("thread-a", blocker("b-2", { question: "Ship or hold?" }));

        assert.deepStrictEqual(
          (yield* store1.listOpenBlockers("thread-a")).map((entry) => entry.id),
          ["b-1", "b-2"],
        );

        yield* store1.answerBlocker("thread-a", "b-1", "take the shim", 6_000);
        assert.deepStrictEqual(
          (yield* store1.listOpenBlockers("thread-a")).map((entry) => entry.id),
          ["b-2"],
        );
        assert.deepStrictEqual(
          (yield* store1.listUndeliveredAnswers("thread-a")).map((entry) => entry.id),
          ["b-1"],
        );

        yield* store1.markBlockersDelivered("thread-a", ["b-1"]);
        assert.deepStrictEqual([...(yield* store1.listUndeliveredAnswers("thread-a"))], []);

        const store2 = yield* makeLoopStore(path);
        const record = yield* store2.getThread("thread-a");
        assert.strictEqual(record.blockers.length, 2);
        assert.strictEqual(record.blockers[0]?.answer, "take the shim");
        assert.strictEqual(record.blockers[0]?.deliveredToAgent, true);
        assert.strictEqual(record.blockers[1]?.answeredAtMs, null);
      }),
    ));

  it("69 — an answer that lands after composition is not marked delivered", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.addBlocker("thread-a", blocker("b-1"));
        yield* store.addBlocker("thread-a", blocker("b-2"));
        yield* store.answerBlocker("thread-a", "b-1", "yes", 6_000);

        // The prompt was composed with b-1 only; b-2 was answered while it was being built.
        const composed = ["b-1"];
        yield* store.answerBlocker("thread-a", "b-2", "no", 6_500);
        yield* store.markBlockersDelivered("thread-a", composed);

        assert.deepStrictEqual(
          (yield* store.listUndeliveredAnswers("thread-a")).map((entry) => entry.id),
          ["b-2"],
        );
      }),
    ));

  it("70 — answering an already-answered blocker keeps the first answer", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.addBlocker("thread-a", blocker("b-1"));
        yield* store.answerBlocker("thread-a", "b-1", "first", 6_000);
        const second = yield* store.answerBlocker("thread-a", "b-1", "second", 7_000);

        assert.strictEqual(second?.answer, "first");
        const record = yield* store.getThread("thread-a");
        assert.strictEqual(record.blockers.length, 1, "not a second append");
        assert.strictEqual(record.blockers[0]?.answer, "first");
        assert.strictEqual(record.blockers[0]?.answeredAtMs, 6_000);
      }),
    ));

  it("70 — answering an unknown blocker is a no-op, not a crash", () =>
    withStore((store) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* store.answerBlocker("thread-a", "nope", "x", 1), null);
        assert.deepStrictEqual([...(yield* store.getThread("thread-a")).blockers], []);
      }),
    ));

  it("70 — adding a blocker twice under one id does not duplicate it", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.addBlocker("thread-a", blocker("b-1"));
        yield* store.addBlocker("thread-a", blocker("b-1", { question: "different text" }));
        const record = yield* store.getThread("thread-a");
        assert.strictEqual(record.blockers.length, 1);
        assert.strictEqual(record.blockers[0]?.question, blocker("b-1").question);
      }),
    ));
});
