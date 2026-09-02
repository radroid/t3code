/**
 * Durable loop store.
 *
 * A single JSON file (`coil-loop.json`, in the server state dir) holding the master
 * settings plus one supervision record per thread. Rehydrated on boot so an armed
 * overnight run survives a server restart — T3's copy is the only durable record that a
 * wake was ever armed, because the provider's own cron table is in-process.
 *
 * Mutations serialize through a `SynchronizedRef` and persist atomically inside the
 * critical section, so memory and disk stay consistent under concurrent access from the
 * tick fiber, the rate-limit fiber, the hook callbacks and the HTTP routes.
 *
 * Deliberately NOT a DB migration: the migration registry is upstream-owned, and adding to
 * it would buy permanent conflict surface for what one JSON file does fine. Mirrors
 * `coil/autoResume/state.ts`, which is proven in production.
 *
 * ## Every field carries a decoding default, and every default is fail-closed
 *
 * This is not style. A missing *required* key fails the whole-file decode, the boot path
 * turns a decode failure into `EMPTY_STATE`, and that would silently disarm every loop on
 * the machine. So each field is `Schema.withDecodingDefaultKey`, and each default is chosen
 * so the reading you get when the field is absent is the one that *spends nothing*:
 * `armed: false`, `deadlineAtMs: 0` and `maxCheckIns: 0` (both ⇒ immediately `spent` on the
 * first stop sweep), `crons: null`, `pinnedByLoop: false`, `global.enabled: false`. A
 * default meaning "unbounded" would turn one truncated write into an unbounded overnight
 * spend, which is the single worst outcome this feature can produce.
 *
 * ## The file is bounded on every write
 *
 * One file is shared by every thread on the machine and is rewritten in full on each
 * mutation, so anything that only ever grows is a cost every other thread pays. Three caps
 * hold it: the ledger keeps its last 20 rows, blockers and recorded user-inputs their last
 * 50 each, and `pruneThreads` drops records nothing will read again — a stopped run older
 * than the retention window, and a record that is neither armed nor carrying anything. All
 * three are applied inside the same critical section that persists, so memory and disk never
 * disagree about what was dropped.
 *
 * @module coil/loop/state
 */

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { writeFileStringAtomically } from "../../atomicWrite.ts";

/**
 * Attaches the fail-closed decoding default described in the module doc.
 *
 * `withDecodingDefaultKey` defaults on an *absent key* (not on `undefined`), and the value
 * it takes is on the Encoded side — which is why a struct whose own fields all carry
 * defaults can itself default to `{}`.
 */
const withDefault = <S extends Schema.Constraint>(schema: S, encodedDefault: S["Encoded"]) =>
  Schema.withDecodingDefaultKey<S>(Effect.succeed(encodedDefault))(schema);

/**
 * One entry of the provider's in-process cron table, as reported by the `Stop` /
 * `SubagentStop` hooks.
 */
export const CronEntry = Schema.Struct({
  id: withDefault(Schema.String, ""),
  /** A 5-field cron expression, NOT a timestamp. */
  schedule: withDefault(Schema.String, ""),
  recurring: withDefault(Schema.Boolean, false),
  /** Truncated to 1000 chars by the binary: console display text, never the agent's prompt. */
  prompt: withDefault(Schema.String, ""),
  /** Computed fork-side by `cron/parse.ts`. `null` = did not parse = NO deference. */
  nextFireAtMs: withDefault(Schema.NullOr(Schema.Number), null),
});
export type CronEntry = typeof CronEntry.Type;

/**
 * The recorded cron snapshot.
 *
 * The *record* being `null` and its `entries` being `[]` are different facts and the
 * trigger reads them differently: `null` = never observed, `{entries: []}` = observed and
 * the agent is not self-pacing.
 */
export const CronRecord = Schema.Struct({
  recordedAtMs: withDefault(Schema.Number, 0),
  entries: withDefault(Schema.Array(CronEntry), []),
});
export type CronRecord = typeof CronRecord.Type;

/** One row of the iteration ledger. */
export const CheckInRow = Schema.Struct({
  n: withDefault(Schema.Number, 0),
  firedAtMs: withDefault(Schema.Number, 0),
  createdAtIso: withDefault(Schema.String, ""),
  /** Where the thread's activity stream stood AT NUDGE TIME — the ledger is unreconstructable without it. */
  activityCursor: withDefault(Schema.String, ""),
  outcome: withDefault(Schema.Literals(["productive", "unproductive", "unknown"]), "unknown"),
});
export type CheckInRow = typeof CheckInRow.Type;

/** Terminal state. Sticky: only a human re-arm clears it. */
export const StopRecord = Schema.Struct({
  reason: withDefault(Schema.Literals(["done", "spent", "stalled", "handed-back"]), "spent"),
  atMs: withDefault(Schema.Number, 0),
  detail: withDefault(Schema.String, ""),
});
export type StopRecord = typeof StopRecord.Type;

/**
 * A blocking question the runtime raised, recorded fork-side.
 *
 * Upstream settles every pending user-input as an empty answer during session teardown, so
 * `hasPendingUserInput` reads false afterwards and a question nobody ever saw is
 * indistinguishable from an answered one. This record is what makes `voided` visible.
 */
export const UserInputRecord = Schema.Struct({
  requestId: withDefault(Schema.String, ""),
  raisedAtMs: withDefault(Schema.Number, 0),
  /** `"resume_return"` for the session-resume dialog; `null` for `AskUserQuestion`. */
  dialogKind: withDefault(Schema.NullOr(Schema.String), null),
  question: withDefault(Schema.String, ""),
  resolution: withDefault(Schema.NullOr(Schema.Literals(["answered", "voided"])), null),
  resolvedAtMs: withDefault(Schema.NullOr(Schema.Number), null),
});
export type UserInputRecord = typeof UserInputRecord.Type;

export const BlockerOption = Schema.Struct({
  label: withDefault(Schema.String, ""),
  description: withDefault(Schema.String, ""),
});
export type BlockerOption = typeof BlockerOption.Type;

/**
 * A deferred question raised through `raise_blocker`, which records and returns rather than
 * parking the turn on a `Deferred`.
 */
export const Blocker = Schema.Struct({
  id: withDefault(Schema.String, ""),
  raisedAtMs: withDefault(Schema.Number, 0),
  question: withDefault(Schema.String, ""),
  /** Empty = free text. */
  options: withDefault(Schema.Array(BlockerOption), []),
  context: withDefault(Schema.NullOr(Schema.String), null),
  answeredAtMs: withDefault(Schema.NullOr(Schema.Number), null),
  answer: withDefault(Schema.NullOr(Schema.String), null),
  /** Answering is asynchronous; this is what stops an answer being delivered twice or lost. */
  deliveredToAgent: withDefault(Schema.Boolean, false),
});
export type Blocker = typeof Blocker.Type;

export const LastCheckIn = Schema.Struct({
  firedAtMs: withDefault(Schema.Number, 0),
  /** The `createdAt` we minted for the nudge, for the exact-string handback compare. */
  createdAtIso: withDefault(Schema.String, ""),
});
export type LastCheckIn = typeof LastCheckIn.Type;

/** Machine-wide settings. `enabled` is the master toggle (guard 2) and defaults OFF. */
export const LoopGlobalSettings = Schema.Struct({
  enabled: withDefault(Schema.Boolean, false),
  maxArmedThreads: withDefault(Schema.Number, 3),
  defaultMaxCheckIns: withDefault(Schema.Number, 6),
  /** Seeds the arm form only. NEVER a fallback deadline. */
  defaultRunMs: withDefault(Schema.Number, 8 * 3_600_000),
  defaultIdleMs: withDefault(Schema.Number, 15 * 60_000),
  defaultBusyIdleMs: withDefault(Schema.Number, 45 * 60_000),
});
export type LoopGlobalSettings = typeof LoopGlobalSettings.Type;

export const LoopRecord = Schema.Struct({
  /** Nothing is supervised implicitly. */
  armed: withDefault(Schema.Boolean, false),
  /** Sentinel freshness baseline: a done-file older than this is a leftover, not a signal. */
  armedAtMs: withDefault(Schema.Number, 0),
  goal: withDefault(Schema.NullOr(Schema.String), null),

  /** 1..20, enforced at the route with a 400. `0` ⇒ immediately `spent`. */
  maxCheckIns: withDefault(Schema.Number, 0),
  checkInsUsed: withDefault(Schema.Number, 0),
  /** Mandatory at arm time, never null. `0` ⇒ epoch ⇒ immediately `spent`. */
  deadlineAtMs: withDefault(Schema.Number, 0),

  idleMs: withDefault(Schema.Number, 15 * 60_000),
  busyIdleMs: withDefault(Schema.Number, 45 * 60_000),

  crons: withDefault(Schema.NullOr(CronRecord), null),
  degraded: withDefault(Schema.NullOr(Schema.Literals(["gate_off", "wake_lost"])), null),
  userInputs: withDefault(Schema.Array(UserInputRecord), []),

  lastCheckIn: withDefault(Schema.NullOr(LastCheckIn), null),
  checkIns: withDefault(Schema.Array(CheckInRow), []),
  strikes: withDefault(Schema.Number, 0),
  /** Durable, so a 5-hour usage limit survives a restart. */
  rateLimitedUntilMs: withDefault(Schema.Number, 0),

  /** Gates the unpin: `false` ⇒ the loop never created the pin ⇒ never remove it. */
  pinnedByLoop: withDefault(Schema.Boolean, false),
  /**
   * When the console asked for the provider session to be ended, or `0`.
   *
   * The route cannot end a session itself — `ProviderService` is not one of the services
   * upstream's `makeRoutesLayer` already requires, and taking it would widen an upstream
   * signature. So a disarm that leaves the agent's own wakes pending records the request
   * here and the supervisor's next tick services it, which keeps `stopSession` on exactly
   * one code path.
   */
  stopRequestedAtMs: withDefault(Schema.Number, 0),
  stopped: withDefault(Schema.NullOr(StopRecord), null),
  overridePrompt: withDefault(Schema.NullOr(Schema.String), null),
  blockers: withDefault(Schema.Array(Blocker), []),

  /**
   * When the agent called the `loop_done` MCP tool, or `null`.
   *
   * The tool-shaped twin of the done-file sentinel, and read the same way: `doneSignal`
   * honours it only when it is newer than `armedAtMs`, so a re-arm supersedes a previous
   * run's call exactly as it supersedes a leftover `.coil/loop-done`. Nothing clears it,
   * for the same reason the supervisor never deletes the file.
   */
  loopDoneAtMs: withDefault(Schema.NullOr(Schema.Number), null),
  /** The `reason` the agent gave, for the stop detail and the console. Display only. */
  loopDoneReason: withDefault(Schema.NullOr(Schema.String), null),
});
export type LoopRecord = typeof LoopRecord.Type;

export const LoopState = Schema.Struct({
  version: Schema.Literal(1),
  global: withDefault(LoopGlobalSettings, {}),
  threads: withDefault(Schema.Record(Schema.String, LoopRecord), {}),
});
export type LoopState = typeof LoopState.Type;

export const DEFAULT_GLOBAL_SETTINGS: LoopGlobalSettings = {
  enabled: false,
  maxArmedThreads: 3,
  defaultMaxCheckIns: 6,
  defaultRunMs: 8 * 3_600_000,
  defaultIdleMs: 15 * 60_000,
  defaultBusyIdleMs: 45 * 60_000,
};

/** The record a thread that has never been armed reads as. Every value is fail-closed. */
export const EMPTY_RECORD: LoopRecord = {
  armed: false,
  armedAtMs: 0,
  goal: null,
  maxCheckIns: 0,
  checkInsUsed: 0,
  deadlineAtMs: 0,
  idleMs: 15 * 60_000,
  busyIdleMs: 45 * 60_000,
  crons: null,
  degraded: null,
  userInputs: [],
  lastCheckIn: null,
  checkIns: [],
  strikes: 0,
  rateLimitedUntilMs: 0,
  pinnedByLoop: false,
  stopRequestedAtMs: 0,
  stopped: null,
  overridePrompt: null,
  blockers: [],
  loopDoneAtMs: null,
  loopDoneReason: null,
};

const EMPTY_STATE: LoopState = { version: 1, global: DEFAULT_GLOBAL_SETTINGS, threads: {} };

/**
 * Structural cap on the persisted ledger.
 *
 * The route caps `maxCheckIns` at 20 and guard 4b stops the loop at the budget, so this is
 * never reached in normal operation — it bounds the file even for a hand-edited record.
 */
const LEDGER_MAX_ROWS = 20;

/**
 * Structural caps on the two append-only lists, applied on write.
 *
 * Both are appended by things outside a run's budget — `raise_blocker` is bounded per
 * check-in window but not per run, and `user-input.requested` fires as often as the agent
 * asks — so without a cap one long-lived thread grows a file every other thread on the
 * machine shares. Fifty is far above what a night produces and far below what makes the file
 * expensive; the oldest entries fall off, which is also the order a human stops caring about
 * them in.
 */
const MAX_BLOCKERS = 50;
const MAX_USER_INPUTS = 50;

/**
 * How long a stopped record survives.
 *
 * The console explains last night's run from this record, so it cannot be dropped when the
 * loop ends — but a month later nobody is reading it and it is pure weight. Armed records
 * are never pruned at any age.
 */
const STOPPED_RETENTION_MS = 30 * 24 * 3_600_000;

/** Anything a human or the supervisor might still want to read back. */
const hasContent = (record: LoopRecord): boolean =>
  record.armed ||
  record.stopped !== null ||
  record.blockers.length > 0 ||
  record.userInputs.length > 0 ||
  record.checkIns.length > 0 ||
  record.crons !== null ||
  record.degraded !== null ||
  record.overridePrompt !== null ||
  record.loopDoneAtMs !== null ||
  record.rateLimitedUntilMs > 0 ||
  record.stopRequestedAtMs > 0;

/**
 * Drop the records nothing will ever read again, on every write.
 *
 * Two rules, both conservative: a stopped run older than the retention window, and a record
 * that is neither armed nor carrying anything (which is what a thread that was armed and
 * then cleared, or one touched by a write that turned out to be a no-op, decays to).
 * `keepThreadId` is the thread the current write is about — pruning it here would make a
 * write followed by a read look like the write never happened.
 */
const pruneThreads = (state: LoopState, nowMs: number, keepThreadId: string | null): LoopState => {
  let dropped = false;
  const threads: Record<string, LoopRecord> = {};
  for (const [threadId, record] of Object.entries(state.threads)) {
    const expired = record.stopped !== null && nowMs - record.stopped.atMs > STOPPED_RETENTION_MS;
    if (threadId !== keepThreadId && !record.armed && (expired || !hasContent(record))) {
      dropped = true;
      continue;
    }
    threads[threadId] = record;
  }
  return dropped ? { ...state, threads } : state;
};

const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(LoopState));

export interface LoopStoreEntry {
  readonly threadId: string;
  readonly record: LoopRecord;
}

/** Everything the arm route must supply. `deadlineAtMs` and `maxCheckIns` are mandatory. */
export interface LoopArmInput {
  readonly threadId: string;
  readonly armedAtMs: number;
  readonly deadlineAtMs: number;
  readonly maxCheckIns: number;
  readonly goal?: string | null;
  /** Omitted ⇒ seeded from `global.defaultIdleMs`. */
  readonly idleMs?: number;
  /** Omitted ⇒ seeded from `global.defaultBusyIdleMs`. */
  readonly busyIdleMs?: number;
  readonly overridePrompt?: string | null;
  /** True ONLY when the arm route itself created the pin. */
  readonly pinnedByLoop?: boolean;
}

export interface RecordCheckInInput {
  readonly threadId: string;
  readonly firedAtMs: number;
  readonly createdAtIso: string;
  readonly activityCursor: string;
}

export interface LoopStoreShape {
  /** The machine-wide settings, including the master toggle. Re-read every tick. */
  readonly getGlobal: Effect.Effect<LoopGlobalSettings>;
  /** Merge a partial settings patch; returns the settings as persisted. */
  readonly setGlobal: (patch: Partial<LoopGlobalSettings>) => Effect.Effect<LoopGlobalSettings>;

  /** Never fails and never 404s: an unknown thread reads as the fail-closed empty record. */
  readonly getThread: (threadId: string) => Effect.Effect<LoopRecord>;
  /** The tick's work list, and the input to guard 14's ceiling check. */
  readonly listArmed: Effect.Effect<ReadonlyArray<LoopStoreEntry>>;

  /**
   * Arm, or re-arm. One operation, because a human re-arm of a stopped loop is a *fresh
   * run*: it clears `stopped`, resets `checkInsUsed` / `strikes` / the ledger, and takes a
   * new `armedAtMs`. Deliberately preserved across a re-arm: `blockers` and `userInputs`
   * (an answer banked before the re-arm is still owed to the agent), `crons` (the provider's
   * table belongs to the session, and arming does not cancel it) and `rateLimitedUntilMs`
   * (an account limit is real whether or not a loop is armed).
   */
  readonly arm: (input: LoopArmInput) => Effect.Effect<LoopRecord>;
  /**
   * Stand a loop down without a terminal breadcrumb — guard 4's "the thread is gone" case.
   * Budget, deadline and ledger stay intact so a re-arm is a deliberate act, not a repair.
   */
  readonly disarm: (threadId: string) => Effect.Effect<void>;
  /** Write the sticky terminal state and disarm. Only `arm` clears it. */
  readonly stop: (threadId: string, stopped: StopRecord) => Effect.Effect<void>;
  /**
   * Forget a thread entirely — the console's "clear" on a finished run.
   *
   * The reverse of `arm`: a stopped pill that cannot be dismissed is a one-way door. Refused
   * at the route while the loop is armed, so this can never be the way a live run ends.
   */
  readonly clearThread: (threadId: string) => Effect.Effect<void>;

  /**
   * Ask the supervisor to end this thread's provider session on its next tick.
   *
   * The console's disarm cannot call `stopSession` itself (see `stopRequestedAtMs`), so it
   * records the request and the reactor services it — one code path, whichever side disarmed.
   */
  readonly requestSessionStop: (threadId: string, atMs: number) => Effect.Effect<void>;
  /** The tick's stop-request work list. In memory only: it issues no query of any kind. */
  readonly listStopRequested: Effect.Effect<ReadonlyArray<LoopStoreEntry>>;
  readonly clearSessionStopRequest: (threadId: string) => Effect.Effect<void>;
  /** The escape hatch for reactor-owned bookkeeping (strikes, ledger outcomes, pins). */
  readonly update: (
    threadId: string,
    f: (record: LoopRecord) => LoopRecord,
  ) => Effect.Effect<LoopRecord>;

  /**
   * Reserve a check-in. The reactor calls this BEFORE `engine.dispatch`, so a provider that
   * cannot spawn burns budget (6 attempts) instead of tight-looping (480 a night). The
   * write is persisted before this effect returns.
   */
  readonly recordCheckIn: (input: RecordCheckInInput) => Effect.Effect<CheckInRow>;
  /** Durable, because a usage limit outlives the process that observed it. */
  readonly setRateLimitedUntil: (threadId: string, untilMs: number) => Effect.Effect<void>;

  /**
   * Replace the cron snapshot. `null` and `{entries: []}` are different facts — the hook
   * simply does not call this when `session_crons` is absent.
   */
  readonly setCrons: (threadId: string, crons: CronRecord | null) => Effect.Effect<void>;
  /** Never inferred and never cleared by accident: a probe that finds nothing does not call this. */
  readonly setDegraded: (
    threadId: string,
    degraded: "gate_off" | "wake_lost" | null,
  ) => Effect.Effect<void>;
  readonly setOverridePrompt: (
    threadId: string,
    overridePrompt: string | null,
  ) => Effect.Effect<void>;

  /** Record a `user-input.requested`. Idempotent on `requestId`. */
  readonly recordUserInput: (threadId: string, input: UserInputRecord) => Effect.Effect<void>;
  /**
   * Resolve a recorded question. First resolution wins, so a teardown void cannot overwrite
   * a human's answer. `"voided"` is the empty-answer teardown case.
   */
  readonly resolveUserInput: (
    threadId: string,
    requestId: string,
    resolution: "answered" | "voided",
    resolvedAtMs: number,
  ) => Effect.Effect<void>;

  readonly addBlocker: (threadId: string, blocker: Blocker) => Effect.Effect<Blocker>;
  /** Idempotent: answering an already-answered blocker keeps the first answer. */
  readonly answerBlocker: (
    threadId: string,
    blockerId: string,
    answer: string,
    answeredAtMs: number,
  ) => Effect.Effect<Blocker | null>;
  /** Unanswered blockers — what the console renders as blocking. */
  readonly listOpenBlockers: (threadId: string) => Effect.Effect<ReadonlyArray<Blocker>>;
  /** Answered but not yet told to the agent — what the next check-in prompt banks. */
  readonly listUndeliveredAnswers: (threadId: string) => Effect.Effect<ReadonlyArray<Blocker>>;
  /**
   * Flip `deliveredToAgent` for exactly the listed ids. Called AFTER the prompt is composed
   * and only for the blockers actually included, so an answer that landed mid-composition
   * is not marked delivered and is not lost.
   */
  readonly markBlockersDelivered: (
    threadId: string,
    blockerIds: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
}

export class LoopStore extends Context.Service<LoopStore, LoopStoreShape>()(
  "t3/coil/loop/state/LoopStore",
) {}

export const makeLoopStore = (
  stateFilePath: string,
): Effect.Effect<LoopStoreShape, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;

    // Rehydrate. Boot never fails, but the four cases must stay distinct so a *transient*
    // read error on a file that still holds valid state is not mistaken for a fresh store —
    // otherwise the first mutation persists an empty file over the still-valid one and
    // silently disarms every loop on the machine:
    //   - no file (fresh install)             -> empty, persistence ON
    //   - present + parses                    -> use it, persistence ON
    //   - present + unparseable (corrupt/vN)  -> empty, persistence ON  (safe to replace)
    //   - present + unreadable (I/O error)    -> empty, persistence OFF (preserve the file)
    const fileExists = yield* fs.exists(stateFilePath).pipe(Effect.orElseSucceed(() => false));
    let initial: LoopState = EMPTY_STATE;
    let persistEnabled = true;
    if (fileExists) {
      const contents = yield* fs.readFileString(stateFilePath).pipe(
        Effect.map((c): string | null => c),
        Effect.orElseSucceed(() => null),
      );
      if (contents === null) {
        persistEnabled = false;
        yield* Effect.logWarning(
          "coil loop: state file present but unreadable; running in-memory only this session so the existing file is not overwritten",
          { stateFilePath },
        );
      } else {
        initial = yield* decodeState(contents).pipe(
          Effect.tapCause((cause) =>
            Effect.logWarning("coil loop: state file did not decode; starting from empty", {
              stateFilePath,
              cause,
            }),
          ),
          Effect.orElseSucceed(() => EMPTY_STATE),
        );
      }
    }

    const ref = yield* SynchronizedRef.make<LoopState>(initial);

    // FileSystem + Path are captured at construction and provided here so the store's public
    // methods carry no context requirement (R = never).
    const persist = (state: LoopState): Effect.Effect<void> => {
      if (!persistEnabled) return Effect.void;
      return writeFileStringAtomically({
        filePath: stateFilePath,
        contents: `${JSON.stringify(state)}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathSvc),
        // A persistence failure must not crash the supervisor; log-and-continue keeps the
        // in-memory state authoritative for this process.
        Effect.catch((cause) =>
          Effect.logWarning("coil loop: failed to persist state", { stateFilePath, cause }),
        ),
      );
    };

    /**
     * Every write goes through here, which is also where the file is bounded: the state is
     * pruned inside the same critical section that persists it, so memory and disk can never
     * disagree about what was dropped. `threadId` is the thread the write is about and is
     * exempt from the prune.
     */
    const modify = <A>(threadId: string | null, f: (state: LoopState) => readonly [A, LoopState]) =>
      SynchronizedRef.modifyEffect(ref, (state) =>
        Effect.gen(function* () {
          const [value, next] = f(state);
          const nowMs = yield* Clock.currentTimeMillis;
          const pruned = pruneThreads(next, nowMs, threadId);
          yield* persist(pruned);
          return [value, pruned] as const;
        }),
      );

    const mutate = (threadId: string | null, f: (state: LoopState) => LoopState) =>
      SynchronizedRef.updateEffect(ref, (state) =>
        Effect.gen(function* () {
          const next = f(state);
          const nowMs = yield* Clock.currentTimeMillis;
          const pruned = pruneThreads(next, nowMs, threadId);
          yield* persist(pruned);
          return pruned;
        }),
      );

    // `Object.hasOwn`, NOT `state.threads[threadId] ?? EMPTY_RECORD`.
    //
    // `threads` is a plain object, so a threadId of `constructor` / `toString` / `valueOf` /
    // `__proto__` resolves on Object.prototype and is *truthy* — `??` never falls through and
    // the caller gets a prototype method typed as a LoopRecord. Reads then dereference
    // `record.armed` (undefined, not false) and writes spread a prototype object with no own
    // enumerable properties, persisting a record missing every key. The next boot fails the
    // WHOLE-file decode, collapses to EMPTY_STATE, and destroys every armed loop. The HTTP
    // route takes threadId straight from the caller, so this is reachable input.
    const recordFor = (state: LoopState, threadId: string): LoopRecord =>
      Object.hasOwn(state.threads, threadId) ? state.threads[threadId]! : EMPTY_RECORD;

    const withRecord = (state: LoopState, threadId: string, record: LoopRecord): LoopState => ({
      ...state,
      threads: { ...state.threads, [threadId]: record },
    });

    const updateRecord = (threadId: string, f: (record: LoopRecord) => LoopRecord) =>
      modify(threadId, (state) => {
        const next = f(recordFor(state, threadId));
        return [next, withRecord(state, threadId, next)] as const;
      });

    const readRecord = <A>(threadId: string, f: (record: LoopRecord) => A) =>
      SynchronizedRef.get(ref).pipe(Effect.map((state) => f(recordFor(state, threadId))));

    return {
      getGlobal: SynchronizedRef.get(ref).pipe(Effect.map((state) => state.global)),

      setGlobal: (patch) =>
        modify(null, (state) => {
          const global = { ...state.global, ...patch };
          return [global, { ...state, global }] as const;
        }),

      getThread: (threadId) => readRecord(threadId, (record) => record),

      listArmed: SynchronizedRef.get(ref).pipe(
        Effect.map((state) =>
          Object.entries(state.threads).flatMap(([threadId, record]) =>
            record.armed ? [{ threadId, record }] : [],
          ),
        ),
      ),

      listStopRequested: SynchronizedRef.get(ref).pipe(
        Effect.map((state) =>
          Object.entries(state.threads).flatMap(([threadId, record]) =>
            record.stopRequestedAtMs > 0 ? [{ threadId, record }] : [],
          ),
        ),
      ),

      arm: (input) =>
        modify(input.threadId, (state) => {
          const previous = recordFor(state, input.threadId);
          const next: LoopRecord = {
            ...previous,
            armed: true,
            armedAtMs: input.armedAtMs,
            goal: input.goal ?? null,
            maxCheckIns: input.maxCheckIns,
            checkInsUsed: 0,
            deadlineAtMs: input.deadlineAtMs,
            idleMs: input.idleMs ?? state.global.defaultIdleMs,
            busyIdleMs: input.busyIdleMs ?? state.global.defaultBusyIdleMs,
            degraded: null,
            lastCheckIn: null,
            checkIns: [],
            strikes: 0,
            pinnedByLoop: input.pinnedByLoop ?? false,
            // A stop request banked by a disarm the human then changed their mind about must
            // never reach the session this arm is starting.
            stopRequestedAtMs: 0,
            stopped: null,
            overridePrompt: input.overridePrompt ?? previous.overridePrompt,
          };
          return [next, withRecord(state, input.threadId, next)] as const;
        }),

      disarm: (threadId) =>
        mutate(threadId, (state) =>
          withRecord(state, threadId, { ...recordFor(state, threadId), armed: false }),
        ),

      stop: (threadId, stopped) =>
        mutate(threadId, (state) =>
          withRecord(state, threadId, { ...recordFor(state, threadId), armed: false, stopped }),
        ),

      clearThread: (threadId) =>
        mutate(null, (state) => {
          if (!Object.hasOwn(state.threads, threadId)) return state;
          const { [threadId]: _removed, ...threads } = state.threads;
          return { ...state, threads };
        }),

      requestSessionStop: (threadId, atMs) =>
        mutate(threadId, (state) =>
          withRecord(state, threadId, {
            ...recordFor(state, threadId),
            stopRequestedAtMs: atMs,
          }),
        ),

      // `null`, not this thread: clearing the last thing a spent record carried is exactly
      // when it becomes prunable.
      clearSessionStopRequest: (threadId) =>
        mutate(null, (state) =>
          withRecord(state, threadId, { ...recordFor(state, threadId), stopRequestedAtMs: 0 }),
        ),

      update: (threadId, f) => updateRecord(threadId, f),

      recordCheckIn: (input) =>
        modify(input.threadId, (state) => {
          const previous = recordFor(state, input.threadId);
          const n = previous.checkInsUsed + 1;
          const row: CheckInRow = {
            n,
            firedAtMs: input.firedAtMs,
            createdAtIso: input.createdAtIso,
            activityCursor: input.activityCursor,
            outcome: "unknown",
          };
          const next: LoopRecord = {
            ...previous,
            checkInsUsed: n,
            checkIns: [...previous.checkIns, row].slice(-LEDGER_MAX_ROWS),
            lastCheckIn: { firedAtMs: input.firedAtMs, createdAtIso: input.createdAtIso },
          };
          return [row, withRecord(state, input.threadId, next)] as const;
        }),

      setRateLimitedUntil: (threadId, untilMs) =>
        mutate(threadId, (state) =>
          withRecord(state, threadId, {
            ...recordFor(state, threadId),
            rateLimitedUntilMs: untilMs,
          }),
        ),

      setCrons: (threadId, crons) =>
        mutate(threadId, (state) =>
          withRecord(state, threadId, { ...recordFor(state, threadId), crons }),
        ),

      setDegraded: (threadId, degraded) =>
        mutate(threadId, (state) =>
          withRecord(state, threadId, { ...recordFor(state, threadId), degraded }),
        ),

      setOverridePrompt: (threadId, overridePrompt) =>
        mutate(threadId, (state) =>
          withRecord(state, threadId, { ...recordFor(state, threadId), overridePrompt }),
        ),

      recordUserInput: (threadId, input) =>
        mutate(threadId, (state) => {
          const previous = recordFor(state, threadId);
          if (previous.userInputs.some((entry) => entry.requestId === input.requestId)) {
            return state;
          }
          return withRecord(state, threadId, {
            ...previous,
            userInputs: [...previous.userInputs, input].slice(-MAX_USER_INPUTS),
          });
        }),

      resolveUserInput: (threadId, requestId, resolution, resolvedAtMs) =>
        mutate(threadId, (state) => {
          const previous = recordFor(state, threadId);
          let changed = false;
          const userInputs = previous.userInputs.map((entry) => {
            if (entry.requestId !== requestId || entry.resolution !== null) return entry;
            changed = true;
            return { ...entry, resolution, resolvedAtMs };
          });
          return changed ? withRecord(state, threadId, { ...previous, userInputs }) : state;
        }),

      addBlocker: (threadId, blocker) =>
        modify(threadId, (state) => {
          const previous = recordFor(state, threadId);
          const existing = previous.blockers.find((entry) => entry.id === blocker.id);
          if (existing) return [existing, state] as const;
          return [
            blocker,
            withRecord(state, threadId, {
              ...previous,
              blockers: [...previous.blockers, blocker].slice(-MAX_BLOCKERS),
            }),
          ] as const;
        }),

      answerBlocker: (threadId, blockerId, answer, answeredAtMs) =>
        modify(threadId, (state) => {
          const previous = recordFor(state, threadId);
          const target = previous.blockers.find((entry) => entry.id === blockerId);
          if (!target) return [null, state] as const;
          if (target.answeredAtMs !== null) return [target, state] as const;
          const answered: Blocker = { ...target, answer, answeredAtMs, deliveredToAgent: false };
          return [
            answered,
            withRecord(state, threadId, {
              ...previous,
              blockers: previous.blockers.map((entry) =>
                entry.id === blockerId ? answered : entry,
              ),
            }),
          ] as const;
        }),

      listOpenBlockers: (threadId) =>
        readRecord(threadId, (record) =>
          record.blockers.filter((entry) => entry.answeredAtMs === null),
        ),

      listUndeliveredAnswers: (threadId) =>
        readRecord(threadId, (record) =>
          record.blockers.filter((entry) => entry.answeredAtMs !== null && !entry.deliveredToAgent),
        ),

      markBlockersDelivered: (threadId, blockerIds) =>
        mutate(threadId, (state) => {
          const previous = recordFor(state, threadId);
          const ids = new Set(blockerIds);
          if (ids.size === 0) return state;
          return withRecord(state, threadId, {
            ...previous,
            blockers: previous.blockers.map((entry) =>
              ids.has(entry.id) ? { ...entry, deliveredToAgent: true } : entry,
            ),
          });
        }),
    } satisfies LoopStoreShape;
  });
