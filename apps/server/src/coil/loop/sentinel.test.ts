// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off - `asDate` below converts fixture millis for `fs.utimes`; nothing reads a clock.
/**
 * TESTS.md cases 47–58 — the done-file.
 *
 * Real `FileSystem` against a temp dir rather than a mock, because every interesting case
 * here is a filesystem edge (mtime ordering, ENOTDIR, a symlink loop, a directory where a
 * file should be) that a hand-written stub would model as whatever the author expected.
 * Where a case is about *how* the module touches the filesystem rather than what it
 * returns — call order (52) and never writing (56) — the real service is wrapped in a
 * recording proxy.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodePath from "node:path";

import { LOOP_DONE_RELATIVE_PATH } from "./config.ts";
import { readSentinel } from "./sentinel.ts";

const ARMED_AT_MS = 1_700_000_000_000;

/**
 * Epoch millis as a `Date`, for `fs.utimes`.
 *
 * Node reads a bare number there as *seconds*, so passing `mtimeMs` straight through
 * silently backdates every fixture by a factor of a thousand.
 */
const asDate = (ms: number) => new Date(ms);

interface Probe {
  readonly fs: FileSystem.FileSystem;
  readonly stats: Array<string>;
  readonly mutations: Array<string>;
}

/**
 * Wraps the real service, recording every `stat` and every mutating call.
 *
 * The mutators delegate rather than throw: the assertion that matters is that the array
 * stays empty, and delegating keeps the wrapper honest about signatures instead of
 * silently diverging from the interface it stands in for.
 */
const probe = (real: FileSystem.FileSystem): Probe => {
  const stats: Array<string> = [];
  const mutations: Array<string> = [];
  const fs: FileSystem.FileSystem = {
    ...real,
    stat: (path) => {
      stats.push(path);
      return real.stat(path);
    },
    writeFile: (path, data, options) => {
      mutations.push(`writeFile:${path}`);
      return real.writeFile(path, data, options);
    },
    writeFileString: (path, data, options) => {
      mutations.push(`writeFileString:${path}`);
      return real.writeFileString(path, data, options);
    },
    makeDirectory: (path, options) => {
      mutations.push(`makeDirectory:${path}`);
      return real.makeDirectory(path, options);
    },
    remove: (path, options) => {
      mutations.push(`remove:${path}`);
      return real.remove(path, options);
    },
    rename: (from, to) => {
      mutations.push(`rename:${from}`);
      return real.rename(from, to);
    },
    utimes: (path, atime, mtime) => {
      mutations.push(`utimes:${path}`);
      return real.utimes(path, atime, mtime);
    },
    open: (path, options) => {
      mutations.push(`open:${path}`);
      return real.open(path, options);
    },
  };
  return { fs, stats, mutations };
};

interface Fixture {
  readonly worktreePath: string;
  readonly workspaceRoot: string;
  /** Writes `<root>/.coil/loop-done` and forces its mtime. */
  readonly writeDone: (
    root: string,
    options?: { readonly contents?: string; readonly mtimeMs?: number },
  ) => Effect.Effect<string, never, never>;
}

const withRoots = <A, E>(
  f: (fixture: Fixture) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "coil-loop-sentinel-" });
    const worktreePath = NodePath.join(base, "worktree");
    const workspaceRoot = NodePath.join(base, "workspace");
    yield* fs.makeDirectory(worktreePath, { recursive: true });
    yield* fs.makeDirectory(workspaceRoot, { recursive: true });

    const writeDone: Fixture["writeDone"] = (root, options = {}) =>
      Effect.gen(function* () {
        const donePath = NodePath.join(root, LOOP_DONE_RELATIVE_PATH);
        yield* fs.makeDirectory(NodePath.dirname(donePath), { recursive: true });
        yield* fs.writeFileString(donePath, options.contents ?? "done\n");
        const mtimeMs = options.mtimeMs ?? ARMED_AT_MS + 60_000;
        yield* fs.utimes(donePath, asDate(mtimeMs), asDate(mtimeMs));
        return donePath;
      }).pipe(Effect.orDie);

    return yield* f({ worktreePath, workspaceRoot, writeDone });
  }).pipe(Effect.scoped, Effect.orDie, Effect.provide(NodeServices.layer), Effect.runPromise);

describe("coil/loop/sentinel", () => {
  // 47
  it("reports absent when neither root holds a done-file", () =>
    withRoots(({ worktreePath, workspaceRoot }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sentinel = yield* readSentinel(
          fs,
          { worktreePath, workspaceRoot },
          { armedAtMs: ARMED_AT_MS },
        );
        assert.strictEqual(sentinel.kind, "absent");
      }),
    ));

  // 48
  it("detects a done-file under the worktree", () =>
    withRoots(({ worktreePath, workspaceRoot, writeDone }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const donePath = yield* writeDone(worktreePath);
        const sentinel = yield* readSentinel(
          fs,
          { worktreePath, workspaceRoot },
          { armedAtMs: ARMED_AT_MS },
        );
        assert.strictEqual(sentinel.kind, "done");
        assert.strictEqual(sentinel.kind === "done" ? sentinel.path : null, donePath);
      }),
    ));

  // 49
  it("detects a done-file under the workspace root", () =>
    withRoots(({ worktreePath, workspaceRoot, writeDone }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const donePath = yield* writeDone(workspaceRoot);
        const sentinel = yield* readSentinel(
          fs,
          { worktreePath, workspaceRoot },
          { armedAtMs: ARMED_AT_MS },
        );
        assert.strictEqual(sentinel.kind, "done");
        assert.strictEqual(sentinel.kind === "done" ? sentinel.path : null, donePath);
      }),
    ));

  // 50
  it("takes the worktree copy when it is the newer of the two", () =>
    withRoots(({ worktreePath, workspaceRoot, writeDone }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* writeDone(workspaceRoot, { mtimeMs: ARMED_AT_MS + 60_000 });
        const newer = yield* writeDone(worktreePath, { mtimeMs: ARMED_AT_MS + 120_000 });
        const sentinel = yield* readSentinel(
          fs,
          { worktreePath, workspaceRoot },
          { armedAtMs: ARMED_AT_MS },
        );
        assert.strictEqual(sentinel.kind === "done" ? sentinel.path : null, newer);
      }),
    ));

  // 51 — newest mtime wins, NOT first found. Precedence orders the stats, not the verdict.
  it("takes the workspace copy when it is the newer of the two", () =>
    withRoots(({ worktreePath, workspaceRoot, writeDone }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* writeDone(worktreePath, { mtimeMs: ARMED_AT_MS + 60_000 });
        const newer = yield* writeDone(workspaceRoot, { mtimeMs: ARMED_AT_MS + 120_000 });
        const sentinel = yield* readSentinel(
          fs,
          { worktreePath, workspaceRoot },
          { armedAtMs: ARMED_AT_MS },
        );
        assert.strictEqual(sentinel.kind === "done" ? sentinel.path : null, newer);
      }),
    ));

  // 52 — asserted by call order, not by outcome: an implementation that statted the
  // workspace root first would still pass 48-51 while disagreeing with the agent's cwd.
  it("stats the worktree before the workspace root", () =>
    withRoots(({ worktreePath, workspaceRoot, writeDone }) =>
      Effect.gen(function* () {
        const real = yield* FileSystem.FileSystem;
        const { fs, stats } = probe(real);
        yield* writeDone(worktreePath);
        yield* writeDone(workspaceRoot);
        yield* readSentinel(fs, { worktreePath, workspaceRoot }, { armedAtMs: ARMED_AT_MS });
        assert.deepStrictEqual(stats, [
          NodePath.join(worktreePath, LOOP_DONE_RELATIVE_PATH),
          NodePath.join(workspaceRoot, LOOP_DONE_RELATIVE_PATH),
        ]);
      }),
    ));

  // 53 — a leftover from a previous run cannot end a new one.
  it("ignores a done-file older than armedAtMs", () =>
    withRoots(({ worktreePath, workspaceRoot, writeDone }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* writeDone(worktreePath, { mtimeMs: ARMED_AT_MS - 60_000 });
        const sentinel = yield* readSentinel(
          fs,
          { worktreePath, workspaceRoot },
          { armedAtMs: ARMED_AT_MS },
        );
        assert.strictEqual(sentinel.kind, "stale");
      }),
    ));

  // 53, the boundary: `mtime > armedAtMs` is strict, so an equal timestamp is stale.
  it("treats a done-file written exactly at armedAtMs as stale", () =>
    withRoots(({ worktreePath, workspaceRoot, writeDone }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* writeDone(worktreePath, { mtimeMs: ARMED_AT_MS });
        const sentinel = yield* readSentinel(
          fs,
          { worktreePath, workspaceRoot },
          { armedAtMs: ARMED_AT_MS },
        );
        assert.strictEqual(sentinel.kind, "stale");
      }),
    ));

  // 54
  it("honours a done-file newer than armedAtMs", () =>
    withRoots(({ worktreePath, workspaceRoot, writeDone }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* writeDone(worktreePath, { mtimeMs: ARMED_AT_MS + 1 });
        const sentinel = yield* readSentinel(
          fs,
          { worktreePath, workspaceRoot },
          { armedAtMs: ARMED_AT_MS },
        );
        assert.strictEqual(sentinel.kind, "done");
        assert.strictEqual(sentinel.kind === "done" ? sentinel.mtimeMs : 0, ARMED_AT_MS + 1);
      }),
    ));

  // 55 — a missing root directory.
  it("reports absent when a root does not exist at all", () =>
    withRoots(({ worktreePath, workspaceRoot }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sentinel = yield* readSentinel(
          fs,
          {
            worktreePath: NodePath.join(worktreePath, "does", "not", "exist"),
            workspaceRoot,
          },
          { armedAtMs: ARMED_AT_MS },
        );
        assert.strictEqual(sentinel.kind, "absent");
      }),
    ));

  // 55 — `.coil` is a regular file, so the candidate path is an ENOTDIR stat error.
  it("reports absent when the .coil path is not a directory", () =>
    withRoots(({ worktreePath, workspaceRoot }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(NodePath.join(worktreePath, ".coil"), "not a directory");
        const sentinel = yield* readSentinel(
          fs,
          { worktreePath, workspaceRoot },
          { armedAtMs: ARMED_AT_MS },
        );
        assert.strictEqual(sentinel.kind, "absent");
      }),
    ));

  // 55 — a self-referential symlink: the stat loops and must not escape as a defect.
  it("reports absent on a symlink loop", () =>
    withRoots(({ worktreePath, workspaceRoot }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const donePath = NodePath.join(worktreePath, LOOP_DONE_RELATIVE_PATH);
        yield* fs.makeDirectory(NodePath.dirname(donePath), { recursive: true });
        yield* fs.symlink(donePath, donePath);
        const sentinel = yield* readSentinel(
          fs,
          { worktreePath, workspaceRoot },
          { armedAtMs: ARMED_AT_MS },
        );
        assert.strictEqual(sentinel.kind, "absent");
      }),
    ));

  // 55 — a directory named loop-done establishes no freshness, so it is not a signal.
  it("reports absent when the done-file is a directory", () =>
    withRoots(({ worktreePath, workspaceRoot }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(NodePath.join(worktreePath, LOOP_DONE_RELATIVE_PATH), {
          recursive: true,
        });
        const sentinel = yield* readSentinel(
          fs,
          { worktreePath, workspaceRoot },
          { armedAtMs: ARMED_AT_MS },
        );
        assert.strictEqual(sentinel.kind, "absent");
      }),
    ));

  // 56 — the supervisor is read-only. This is the property that makes it safe to point at
  // an arbitrary repo, so it is asserted on the *hit* path, not just the absent one.
  it("never writes to the user's tree", () =>
    withRoots(({ worktreePath, workspaceRoot, writeDone }) =>
      Effect.gen(function* () {
        const real = yield* FileSystem.FileSystem;
        yield* writeDone(worktreePath);
        const { fs, mutations } = probe(real);
        yield* readSentinel(fs, { worktreePath, workspaceRoot }, { armedAtMs: ARMED_AT_MS });
        yield* readSentinel(
          fs,
          { worktreePath: null, workspaceRoot: NodePath.join(workspaceRoot, "missing") },
          { armedAtMs: ARMED_AT_MS },
        );
        assert.deepStrictEqual(mutations, []);
      }),
    ));

  // 57
  it("captures the first line for display without letting contents decide", () =>
    withRoots(({ worktreePath, workspaceRoot, writeDone }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* writeDone(worktreePath, {
          contents: "  shipped the migration  \nplus a second line nobody reads\n",
        });
        const sentinel = yield* readSentinel(
          fs,
          { worktreePath, workspaceRoot },
          { armedAtMs: ARMED_AT_MS },
        );
        assert.strictEqual(sentinel.kind, "done");
        assert.strictEqual(
          sentinel.kind === "done" ? sentinel.firstLine : null,
          "shipped the migration",
        );
      }),
    ));

  // 57 — an empty file is still a done-file; only the display text is missing.
  it("still reports done for an empty file", () =>
    withRoots(({ worktreePath, workspaceRoot, writeDone }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* writeDone(worktreePath, { contents: "" });
        const sentinel = yield* readSentinel(
          fs,
          { worktreePath, workspaceRoot },
          { armedAtMs: ARMED_AT_MS },
        );
        assert.strictEqual(sentinel.kind, "done");
        assert.strictEqual(sentinel.kind === "done" ? sentinel.firstLine : "unset", null);
      }),
    ));

  // 58 — freshness is mtimeMs only. A model that guesses the wall clock badly must not be
  // able to make `done` unreachable (nor to reach it from a stale file).
  it("never reads a timestamp written inside the file", () =>
    withRoots(({ worktreePath, workspaceRoot, writeDone }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Contents claim 1999; the mtime is fresh, so this is done.
        yield* writeDone(worktreePath, {
          contents: `finished at 1999-01-01T00:00:00.000Z`,
          mtimeMs: ARMED_AT_MS + 5_000,
        });
        const fresh = yield* readSentinel(
          fs,
          { worktreePath, workspaceRoot },
          { armedAtMs: ARMED_AT_MS },
        );
        assert.strictEqual(fresh.kind, "done");

        // Contents claim the future; the mtime is stale, so this is not.
        yield* writeDone(workspaceRoot, {
          contents: "finished at 2099-01-01T00:00:00.000Z",
          mtimeMs: ARMED_AT_MS - 5_000,
        });
        const stale = yield* readSentinel(
          fs,
          { worktreePath: null, workspaceRoot },
          { armedAtMs: ARMED_AT_MS },
        );
        assert.strictEqual(stale.kind, "stale");
      }),
    ));

  // The roots collapse to one when a thread has no worktree, and a duplicate root is
  // statted once — `resolveLoopRoots` dedupes, which keeps the ledger of stats honest.
  it("stats a single root once when both inputs point at it", () =>
    withRoots(({ workspaceRoot, writeDone }) =>
      Effect.gen(function* () {
        const real = yield* FileSystem.FileSystem;
        const { fs, stats } = probe(real);
        yield* writeDone(workspaceRoot);
        const sentinel = yield* readSentinel(
          fs,
          { worktreePath: workspaceRoot, workspaceRoot },
          { armedAtMs: ARMED_AT_MS },
        );
        assert.strictEqual(sentinel.kind, "done");
        assert.strictEqual(stats.length, 1);
      }),
    ));

  it("reports absent when no root is known at all", () =>
    withRoots(() =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sentinel = yield* readSentinel(
          fs,
          { worktreePath: null, workspaceRoot: null },
          { armedAtMs: ARMED_AT_MS },
        );
        assert.strictEqual(sentinel.kind, "absent");
      }),
    ));
});
