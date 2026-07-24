/**
 * Durable pending-resume store.
 *
 * A single JSON file (in the server state dir) holding one pending resume per thread
 * plus a small fired-history for rate caps. Rehydrated on boot so an in-flight wait
 * survives a server restart. Mutations are serialized through a `SynchronizedRef` and
 * persisted atomically inside the critical section, keeping memory and disk consistent
 * even under concurrent access from the detection and wake fibers.
 *
 * Deliberately NOT a DB migration: the migration registry is upstream-owned, and adding
 * to it would buy permanent conflict surface for what a ~single JSON file does fine.
 *
 * @module t3x/autoResume/state
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { writeFileStringAtomically } from "../../atomicWrite.ts";

const FIRED_HISTORY_RETENTION_MS = 25 * 60 * 60_000; // a little over the 24h cap window

export const PendingResume = Schema.Struct({
  threadId: Schema.String,
  resumeAtMs: Schema.Number,
  /** Human-readable reason for the timeline activity (e.g. "five_hour window"). */
  reason: Schema.String,
  scheduledAtMs: Schema.Number,
  baseline: Schema.Struct({
    newestUserMessageId: Schema.NullOr(Schema.String),
    latestTurnId: Schema.NullOr(Schema.String),
  }),
});
export type PendingResume = typeof PendingResume.Type;

const ThreadRecord = Schema.Struct({
  pending: Schema.NullOr(PendingResume),
  firedAtMs: Schema.Array(Schema.Number),
  /** Optional per-thread resume prompt override (settable by the UI). */
  overridePrompt: Schema.NullOr(Schema.String),
  /**
   * Per-thread auto-resume switch (default on).
   *
   * Optional *on disk* with a decode-time default of `true`: state files written
   * before this field existed must still decode. A missing **required** key would
   * fail the whole-file decode, and the boot path turns a decode failure into
   * `EMPTY_STATE` — silently dropping every pending resume and the fired history.
   */
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});
type ThreadRecord = typeof ThreadRecord.Type;

export const AutoResumeState = Schema.Struct({
  version: Schema.Literal(1),
  threads: Schema.Record(Schema.String, ThreadRecord),
});
export type AutoResumeState = typeof AutoResumeState.Type;

const EMPTY_STATE: AutoResumeState = { version: 1, threads: {} };
const EMPTY_RECORD: ThreadRecord = {
  pending: null,
  firedAtMs: [],
  overridePrompt: null,
  enabled: true,
};

const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(AutoResumeState));

export interface AutoResumeStoreShape {
  readonly listPending: Effect.Effect<ReadonlyArray<PendingResume>>;
  readonly getThread: (threadId: string) => Effect.Effect<ThreadRecord>;
  readonly schedule: (entry: PendingResume) => Effect.Effect<void>;
  readonly clearPending: (threadId: string) => Effect.Effect<void>;
  /** Record that a resume fired: clears pending and appends to fired-history. */
  readonly recordFired: (threadId: string, atMs: number) => Effect.Effect<void>;
  /** How many resumes fired for a thread since `sinceMs` (for caps + backoff). */
  readonly countFiredSince: (threadId: string, sinceMs: number) => Effect.Effect<number>;
  /** Turn auto-resume on/off for a single thread (the UI toggle). */
  readonly setEnabled: (threadId: string, enabled: boolean) => Effect.Effect<void>;
  /** Set the per-thread resume text; `null` falls back to the configured default. */
  readonly setOverridePrompt: (
    threadId: string,
    overridePrompt: string | null,
  ) => Effect.Effect<void>;
}

export class AutoResumeStore extends Context.Service<AutoResumeStore, AutoResumeStoreShape>()(
  "t3/t3x/autoResume/state/AutoResumeStore",
) {}

function pruneFired(firedAtMs: ReadonlyArray<number>, nowMs: number): ReadonlyArray<number> {
  const cutoff = nowMs - FIRED_HISTORY_RETENTION_MS;
  return firedAtMs.filter((t) => t >= cutoff);
}

export const makeAutoResumeStore = (
  stateFilePath: string,
): Effect.Effect<AutoResumeStoreShape, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;

    // Rehydrate. Boot never fails, but we must distinguish three cases so a *transient*
    // read error (EACCES/EIO on a file that still holds valid state) is not mistaken for a
    // fresh/empty store — otherwise the first mutation would persist an empty file over the
    // still-valid one, permanently losing pending resumes + fired history:
    //   - no file (fresh install)              -> empty, persistence ON
    //   - present + parses                     -> use it,   persistence ON
    //   - present + unparseable (corrupt/vN)   -> empty,    persistence ON (safe to replace)
    //   - present + unreadable (I/O error)     -> empty,    persistence OFF (preserve file)
    const fileExists = yield* fs.exists(stateFilePath).pipe(Effect.orElseSucceed(() => false));
    let initial: AutoResumeState = EMPTY_STATE;
    let persistEnabled = true;
    if (fileExists) {
      const contents = yield* fs.readFileString(stateFilePath).pipe(
        Effect.map((c): string | null => c),
        Effect.orElseSucceed(() => null),
      );
      if (contents === null) {
        persistEnabled = false;
        yield* Effect.logWarning(
          "t3x auto-resume: state file present but unreadable; running in-memory only this session so the existing file is not overwritten",
          { stateFilePath },
        );
      } else {
        initial = yield* decodeState(contents).pipe(Effect.orElseSucceed(() => EMPTY_STATE));
      }
    }

    const ref = yield* SynchronizedRef.make<AutoResumeState>(initial);

    // FileSystem + Path are captured at construction and provided here so the store's
    // public methods carry no context requirement (R = never).
    const persist = (state: AutoResumeState): Effect.Effect<void> => {
      if (!persistEnabled) return Effect.void;
      return writeFileStringAtomically({
        filePath: stateFilePath,
        contents: `${JSON.stringify(state)}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathSvc),
        // Persistence failure must not crash the supervisor; log-and-continue keeps the
        // in-memory state authoritative for this process.
        Effect.catch((cause) =>
          Effect.logWarning("t3x auto-resume: failed to persist state", {
            stateFilePath,
            cause,
          }),
        ),
      );
    };

    const mutate = (f: (state: AutoResumeState) => AutoResumeState) =>
      SynchronizedRef.updateEffect(ref, (state) => {
        const next = f(state);
        return persist(next).pipe(Effect.as(next));
      });

    const recordFor = (state: AutoResumeState, threadId: string): ThreadRecord =>
      state.threads[threadId] ?? EMPTY_RECORD;

    return {
      listPending: SynchronizedRef.get(ref).pipe(
        Effect.map((state) =>
          Object.values(state.threads).flatMap((record) =>
            record.pending ? [record.pending] : [],
          ),
        ),
      ),

      getThread: (threadId) =>
        SynchronizedRef.get(ref).pipe(Effect.map((state) => recordFor(state, threadId))),

      schedule: (entry) =>
        mutate((state) => {
          const record = recordFor(state, entry.threadId);
          return {
            ...state,
            threads: {
              ...state.threads,
              [entry.threadId]: { ...record, pending: entry },
            },
          };
        }),

      clearPending: (threadId) =>
        mutate((state) => {
          const record = state.threads[threadId];
          if (!record || record.pending === null) return state;
          return {
            ...state,
            threads: { ...state.threads, [threadId]: { ...record, pending: null } },
          };
        }),

      recordFired: (threadId, atMs) =>
        mutate((state) => {
          const record = recordFor(state, threadId);
          return {
            ...state,
            threads: {
              ...state.threads,
              [threadId]: {
                ...record,
                pending: null,
                firedAtMs: pruneFired([...record.firedAtMs, atMs], atMs),
              },
            },
          };
        }),

      countFiredSince: (threadId, sinceMs) =>
        SynchronizedRef.get(ref).pipe(
          Effect.map(
            (state) => recordFor(state, threadId).firedAtMs.filter((t) => t >= sinceMs).length,
          ),
        ),

      setEnabled: (threadId, enabled) =>
        mutate((state) => ({
          ...state,
          threads: {
            ...state.threads,
            [threadId]: { ...recordFor(state, threadId), enabled },
          },
        })),

      setOverridePrompt: (threadId, overridePrompt) =>
        mutate((state) => ({
          ...state,
          threads: {
            ...state.threads,
            [threadId]: { ...recordFor(state, threadId), overridePrompt },
          },
        })),
    } satisfies AutoResumeStoreShape;
  });
