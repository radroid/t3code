/**
 * The done-file sentinel — how an agent ends its own loop.
 *
 * The agent writes `<root>/.coil/loop-done`; the supervisor only ever *stats* it. That
 * asymmetry is the whole safety argument for pointing this feature at an arbitrary repo:
 * there is no code path here that writes, creates or removes anything under the user's
 * tree, and `readSentinel` takes its `FileSystem` as an argument partly so a test can hand
 * it a proxy that fails on every mutating method.
 *
 * Three rules, each of which has a way of being quietly re-broken:
 *
 *  1. **Worktree first.** The roots are `worktreePath ?? workspaceRoot`, in that order,
 *     because `resolveThreadWorkspaceCwd` hands the *agent* the worktree. `autoResume/`
 *     resolves from `workspaceRoot` only; copying it would leave the agent writing the
 *     done-file where the supervisor never looks, on every worktree-backed thread.
 *  2. **Freshness is `mtimeMs`, never a timestamp inside the file.** Models do not know the
 *     wall clock, so gating `done` on a model-authored timestamp makes `done` unreachable
 *     whenever it guesses wrong. Contents are read for *display* and never for detection.
 *  3. **Every filesystem failure means "no sentinel".** EACCES, a symlink loop, a missing
 *     parent directory, a `.coil/loop-done` that is a directory, a stat with no mtime — all
 *     of them resolve to `absent` rather than a crash, because this runs inside the tick
 *     fiber and a defect there stops supervision for every thread on the machine.
 *
 * @module coil/loop/sentinel
 */

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { LOOP_DONE_RELATIVE_PATH, resolveLoopRoots } from "./config.ts";

/** How much of the done-file's first line the console is offered. */
const FIRST_LINE_MAX_CHARS = 200;

export interface SentinelRoots {
  readonly worktreePath: string | null;
  readonly workspaceRoot: string | null;
}

export interface SentinelOptions {
  /**
   * The run's `armedAtMs`. A done-file at or before it is a leftover from a previous run
   * and must not end this one — which is the only reason `arm` takes a fresh `armedAtMs`.
   */
  readonly armedAtMs: number;
}

/**
 * What the supervisor found.
 *
 * `firstLine` is `null` when the file could not be read or held nothing printable. That is
 * deliberately *not* a fourth variant: an unreadable done-file is still a done-file, since
 * detection is `mtimeMs` alone (rule 2). Modelling "unreadable" as its own state would make
 * a permissions quirk on a file the agent already wrote look like the run never ended.
 */
export type LoopSentinel =
  | { readonly kind: "absent" }
  | {
      /** Present, but not newer than `armedAtMs`: a leftover, not a signal. */
      readonly kind: "stale";
      readonly path: string;
      readonly mtimeMs: number;
      readonly firstLine: string | null;
    }
  | {
      readonly kind: "done";
      readonly path: string;
      readonly mtimeMs: number;
      readonly firstLine: string | null;
    };

export const SENTINEL_ABSENT: LoopSentinel = { kind: "absent" };

interface SentinelHit {
  readonly path: string;
  readonly mtimeMs: number;
}

/**
 * Stats one candidate path, resolving every failure mode to `null`.
 *
 * A non-`File` entry and a stat carrying no `mtime` are both rejected here rather than
 * downstream: neither can establish freshness, and treating either as a hit would let a
 * directory named `loop-done` end a run at the epoch.
 */
const statCandidate = (
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<SentinelHit | null> =>
  fs.stat(path).pipe(
    Effect.map((info): SentinelHit | null => {
      if (info.type !== "File") return null;
      const mtime = Option.getOrNull(info.mtime);
      if (mtime === null) return null;
      const mtimeMs = mtime.getTime();
      return Number.isFinite(mtimeMs) ? { path, mtimeMs } : null;
    }),
    Effect.orElseSucceed(() => null),
  );

/** Display text only. An unreadable or blank file yields `null` and changes no verdict. */
const readFirstLine = (fs: FileSystem.FileSystem, path: string): Effect.Effect<string | null> =>
  fs.readFileString(path).pipe(
    Effect.map((contents): string | null => {
      const line = contents.split("\n", 1)[0]?.trim() ?? "";
      return line.length === 0 ? null : line.slice(0, FIRST_LINE_MAX_CHARS);
    }),
    Effect.orElseSucceed(() => null),
  );

/**
 * Reads the done-file across both roots.
 *
 * The roots are visited **worktree first** and every root is statted, because the newest
 * `mtimeMs` wins rather than the first hit: a stale worktree copy must not mask a fresh one
 * under the workspace root. Ties keep the earlier root, so the worktree stays authoritative
 * when both files carry the same timestamp.
 *
 * `fs` is a parameter rather than a context read so the caller resolves it once per tick and
 * so the read-only property is testable by substitution.
 */
export const readSentinel = (
  fs: FileSystem.FileSystem,
  roots: SentinelRoots,
  options: SentinelOptions,
): Effect.Effect<LoopSentinel, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    let best: SentinelHit | null = null;
    for (const root of resolveLoopRoots(roots)) {
      const hit = yield* statCandidate(fs, path.join(root, LOOP_DONE_RELATIVE_PATH));
      if (hit !== null && (best === null || hit.mtimeMs > best.mtimeMs)) {
        best = hit;
      }
    }
    if (best === null) return SENTINEL_ABSENT;

    const firstLine = yield* readFirstLine(fs, best.path);
    return {
      kind: best.mtimeMs > options.armedAtMs ? "done" : "stale",
      path: best.path,
      mtimeMs: best.mtimeMs,
      firstLine,
    };
  });
