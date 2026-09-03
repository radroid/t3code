/**
 * Test harness for the loop supervisor.
 *
 * Boots the **real** `LoopReactorLive` and the **real** durable `LoopStore` against a
 * scripted projection and a recording orchestration engine, on Effect's `TestClock` so an
 * eight-hour overnight run costs milliseconds. Only four things are doubles, and each is a
 * deliberate cut:
 *
 *   - **Orchestration engine** — records dispatched commands instead of running turns, and
 *     can be told to fail a chosen command type. Dispatch is the reactor's output.
 *   - **Projection snapshot** — two mutable shell rows the scenario scripts, read through
 *     the same `getThreadShellById` / `getProjectShellById` the reactor uses, with a call
 *     counter so "zero SQL when nothing is armed" is assertable.
 *   - **Provider** — `streamEvents` pre-loaded with the scenario's events (emit-then-block,
 *     so delivery does not depend on publish timing) and a recording `stopSession`.
 *   - **Auto-resume store** — one boolean, because guard 9 reads exactly one field.
 *
 * The store, the reactor, its config, its guards, its decision table, its sentinel reads and
 * its persistence are all real.
 *
 * Nothing here waits by counting scheduler turns. The reactor publishes a receipt at every
 * milestone (`receipts.ts`) and every wait below is an await on one, so a scenario's timing is
 * a property of the scenario and not of the machine running it.
 *
 * @module coil/loop/reactorHarness
 */

// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalErrorInEffectFailure:off -- the engine stub raises bare Errors on
// purpose, mirroring the arbitrary driver throws the reactor must survive.
// @effect-diagnostics globalDate:off -- msToIso is a pure ms->ISO helper for fixtures; the
// value it formats is a TestClock offset, never a wall-clock reading.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  OrchestrationCommand,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { AutoResumeStore } from "../autoResume/state.ts";
import { LOOP_DONE_RELATIVE_PATH } from "./config.ts";
import {
  type LoopReactorReceipt,
  LoopReactorReceipts,
  LoopReactorReceiptsLive,
} from "./receipts.ts";
import { LoopStore, makeLoopStore } from "./state.ts";

export const LOOP_THREAD_ID = "thread-1";
export const LOOP_PROJECT_ID = "project-1";

/** Handy constants so a scenario reads in the units the design talks in. */
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** The reactor's default poll cadence, and therefore the granularity of every scenario. */
export const POLL_MS = MINUTE;

/**
 * Test-clock milliseconds as an ISO timestamp.
 *
 * `TestClock` begins at epoch 0, so a scenario's "now" is 1970. Every projection field the
 * trigger parses (`updatedAt`, `latestUserMessageAt`, `snoozedUntil`) is compared against
 * that clock, so a real 2026 timestamp in a fixture silently inverts the scenario.
 */
export const msToIso = (ms: number): string => new Date(ms).toISOString();

/**
 * The reactor reads `COIL_LOOP_*` once, at layer construction. A developer with any of them
 * exported would otherwise change the meaning of every timing assertion in these files.
 */
export const clearLoopEnv = (): void => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("COIL_LOOP_")) delete process.env[key];
  }
};

export interface ThreadShellOverrides {
  readonly id?: string;
  readonly updatedAt?: string;
  readonly archivedAt?: string | null;
  readonly settledOverride?: "settled" | "active" | null;
  readonly snoozedUntil?: string | null;
  readonly sessionStatus?: string | null;
  readonly providerName?: string;
  readonly latestTurnState?: string | null;
  readonly latestUserMessageAt?: string | null;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly hasActionableProposedPlan?: boolean;
  readonly backgroundLiveness?: "working" | "monitoring" | null;
  readonly worktreePath?: string | null;
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
}

/**
 * A thread shell row.
 *
 * Cast once at the end because building every branded field (`ThreadId`, `IsoDateTime`,
 * `ModelSelection`, …) is noise the reactor never reads — the fields it *does* read are all
 * set explicitly above, which is what makes the cast safe rather than a hole.
 */
export const threadShell = (o: ThreadShellOverrides = {}): OrchestrationThreadShell =>
  ({
    id: o.id ?? LOOP_THREAD_ID,
    projectId: LOOP_PROJECT_ID,
    title: "a thread",
    modelSelection: { providerName: "claudeAgent", modelId: "sonnet" },
    runtimeMode: o.runtimeMode ?? "full-access",
    interactionMode: o.interactionMode ?? "default",
    branch: null,
    worktreePath: o.worktreePath ?? null,
    latestTurn:
      o.latestTurnState === undefined || o.latestTurnState === null
        ? null
        : { turnId: "turn-1", state: o.latestTurnState },
    createdAt: msToIso(0),
    updatedAt: o.updatedAt ?? msToIso(0),
    archivedAt: o.archivedAt ?? null,
    settledOverride: o.settledOverride ?? null,
    settledAt: null,
    snoozedUntil: o.snoozedUntil ?? null,
    pinnedAt: null,
    session:
      o.sessionStatus === null
        ? null
        : {
            status: o.sessionStatus ?? "ready",
            providerName: o.providerName ?? "claudeAgent",
          },
    latestUserMessageAt: o.latestUserMessageAt ?? null,
    hasPendingApprovals: o.hasPendingApprovals ?? false,
    hasPendingUserInput: o.hasPendingUserInput ?? false,
    hasActionableProposedPlan: o.hasActionableProposedPlan ?? false,
    backgroundLiveness: o.backgroundLiveness ?? null,
  }) as unknown as OrchestrationThreadShell;

export const projectShell = (workspaceRoot: string): OrchestrationProjectShell =>
  ({
    id: LOOP_PROJECT_ID,
    title: "a project",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: msToIso(0),
    updatedAt: msToIso(0),
  }) as unknown as OrchestrationProjectShell;

/** A Claude `account.rate-limits.updated` runtime event. */
export const rateLimitEvent = (o: {
  readonly status: "allowed" | "allowed_warning" | "rejected";
  readonly resetsAtSeconds?: number;
  readonly threadId?: string;
}): ProviderRuntimeEvent =>
  ({
    type: "account.rate-limits.updated",
    eventId: `evt-rl-${o.status}-${o.resetsAtSeconds ?? 0}`,
    provider: "claudeAgent",
    threadId: o.threadId ?? LOOP_THREAD_ID,
    createdAt: msToIso(0),
    payload: {
      rateLimits: {
        type: "rate_limit_event",
        rate_limit_info: {
          status: o.status,
          rateLimitType: "five_hour",
          ...(o.resetsAtSeconds === undefined ? {} : { resetsAt: o.resetsAtSeconds }),
        },
      },
    },
  }) as unknown as ProviderRuntimeEvent;

/** A `user-input.requested` runtime event, for the two-subscriber proof. */
export const userInputRequestedEvent = (o: {
  readonly requestId: string;
  readonly question: string;
  readonly threadId?: string;
}): ProviderRuntimeEvent =>
  ({
    type: "user-input.requested",
    eventId: `evt-ui-${o.requestId}`,
    provider: "claudeAgent",
    threadId: o.threadId ?? LOOP_THREAD_ID,
    requestId: o.requestId,
    createdAt: msToIso(0),
    payload: { questions: [{ question: o.question, options: [] }] },
  }) as unknown as ProviderRuntimeEvent;

export interface HarnessOptions {
  /** The thread row the projection returns. `null` models a deleted thread. */
  readonly shell?: OrchestrationThreadShell | null;
  /** Runtime events, pre-loaded emit-then-block. */
  readonly events?: ReadonlyArray<ProviderRuntimeEvent>;
  /** Guard 9's one field. */
  readonly autoResumePending?: boolean;
  /** Additional thread rows, keyed by id, for multi-thread scenarios. */
  readonly extraShells?: ReadonlyArray<OrchestrationThreadShell>;
}

export const harness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "coil-loop-" });
    const workspaceRoot = NodePath.join(root, "workspace");
    yield* fs.makeDirectory(workspaceRoot, { recursive: true });
    const statePath = NodePath.join(root, "coil-loop.json");

    const dispatched = yield* Ref.make<OrchestrationCommand[]>([]);
    /** Command types the engine should reject, so a scenario can break exactly one path. */
    const failCommandTypes = yield* Ref.make<ReadonlySet<string>>(new Set<string>());
    /** Defect (not failure) to raise from dispatch, for the "a defect cannot kill it" cases. */
    const dieOnCommandType = yield* Ref.make<string | null>(null);
    /** Same, scoped to one thread, so a multi-thread pass can prove the others still run. */
    const dieOnThreadId = yield* Ref.make<string | null>(null);

    const EngineStub = Layer.succeed(OrchestrationEngineService, {
      dispatch: (command: OrchestrationCommand) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(dieOnCommandType)) === command.type) {
            throw new Error(`simulated defect dispatching ${command.type}`);
          }
          if (
            command.type === "thread.turn.start" &&
            (yield* Ref.get(dieOnThreadId)) === command.threadId
          ) {
            throw new Error(`simulated defect for ${command.threadId}`);
          }
          if ((yield* Ref.get(failCommandTypes)).has(command.type)) {
            return yield* Effect.fail(new Error(`simulated failure: ${command.type}`));
          }
          yield* Ref.update(dispatched, (all) => [...all, command]);
          return { sequence: 0 };
        }),
      streamDomainEvents: Stream.empty,
      readEvents: () => Stream.empty,
      latestSequence: Effect.succeed(0),
    } as unknown as typeof OrchestrationEngineService.Service);

    const shellRef = yield* Ref.make<OrchestrationThreadShell | null>(
      options.shell === undefined ? threadShell() : options.shell,
    );
    const extraShellsRef = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>(
      options.extraShells ?? [],
    );
    /**
     * Swaps in a different row once the tick has read the shell `afterCall` times, which is
     * how the wake race is scripted: the guard block sees one world and the pre-dispatch
     * re-read sees another.
     */
    const shellOverrideRef = yield* Ref.make<{
      readonly afterCall: number;
      readonly shell: OrchestrationThreadShell | null;
    } | null>(null);
    const shellCalls = yield* Ref.make(0);
    const projectCalls = yield* Ref.make(0);
    /** Set to make the projection read fail, distinct from "the thread is gone". */
    const shellReadFails = yield* Ref.make(false);
    /**
     * Fail reads only from call `n + 1` on, the same shape `shellOverrideRef` uses — which is
     * how a scenario makes the *pre-dispatch* re-read fail while the guard block's read
     * succeeded. The two are different worlds and the reactor must not conflate them.
     */
    const shellFailsAfterCall = yield* Ref.make<number | null>(null);

    const SnapshotStub = Layer.succeed(ProjectionSnapshotQuery, {
      getThreadShellById: (threadId: string) =>
        Effect.gen(function* () {
          const n = yield* Ref.updateAndGet(shellCalls, (c) => c + 1);
          const failAfter = yield* Ref.get(shellFailsAfterCall);
          if ((yield* Ref.get(shellReadFails)) || (failAfter !== null && n > failAfter)) {
            return yield* Effect.fail(new Error("simulated projection failure"));
          }
          const extra = (yield* Ref.get(extraShellsRef)).find((s) => s.id === threadId);
          if (extra) return Option.some(extra);
          const override = yield* Ref.get(shellOverrideRef);
          const shell =
            override !== null && n > override.afterCall ? override.shell : yield* Ref.get(shellRef);
          if (shell === null || shell.id !== threadId) return Option.none();
          return Option.some(shell);
        }),
      getProjectShellById: () =>
        Ref.update(projectCalls, (c) => c + 1).pipe(
          Effect.as(Option.some(projectShell(workspaceRoot))),
        ),
    } as unknown as typeof ProjectionSnapshotQuery.Service);

    const stopSessions = yield* Ref.make<string[]>([]);
    const ProviderStub = Layer.succeed(ProviderService, {
      get streamEvents() {
        return Stream.concat(Stream.fromIterable(options.events ?? []), Stream.never);
      },
      stopSession: (input: { readonly threadId: string }) =>
        Ref.update(stopSessions, (all) => [...all, input.threadId]),
    } as unknown as typeof ProviderService.Service);

    const autoResumePending = yield* Ref.make(options.autoResumePending ?? false);
    const AutoResumeStub = Layer.succeed(AutoResumeStore, {
      getThread: (_threadId: string) =>
        Ref.get(autoResumePending).pipe(
          Effect.map((pending) => ({
            enabled: true,
            overridePrompt: null,
            pending: pending ? { threadId: _threadId, resumeAtMs: 0 } : null,
            fired: [],
          })),
        ),
    } as unknown as typeof AutoResumeStore.Service);

    const store = yield* makeLoopStore(statePath);
    const StoreLive = Layer.succeed(LoopStore, store);

    // Crypto.make derives randomUUIDv4 from randomBytes; a counter keeps bytes distinct so
    // generated command/message ids differ across calls.
    let seed = 1;
    const CryptoStub = Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => {
          const bytes = new Uint8Array(size);
          for (let i = 0; i < size; i++) bytes[i] = (seed + i) & 0xff;
          seed += size;
          return bytes;
        },
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    );

    const deps = Layer.mergeAll(
      EngineStub,
      SnapshotStub,
      ProviderStub,
      AutoResumeStub,
      CryptoStub,
      StoreLive,
      // Test-only, and the whole reason the waits below are exact. Production never provides
      // it, so the reactor's emitter resolves to a no-op there. See `receipts.ts`.
      LoopReactorReceiptsLive,
    );

    return {
      deps,
      store,
      statePath,
      workspaceRoot,
      dispatched,
      failCommandTypes,
      dieOnCommandType,
      dieOnThreadId,
      shellRef,
      shellOverrideRef,
      extraShellsRef,
      shellCalls,
      projectCalls,
      shellReadFails,
      shellFailsAfterCall,
      stopSessions,
      autoResumePending,
    };
  });

/** Write the done-file with an explicit mtime **on the test clock**. */
export const writeSentinel = (workspaceRoot: string, mtimeMs: number): Effect.Effect<void> =>
  Effect.promise(async () => {
    const filePath = NodePath.join(workspaceRoot, LOOP_DONE_RELATIVE_PATH);
    await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
    await NodeFSP.writeFile(filePath, "finished\n");
    // `utimes` takes SECONDS, not milliseconds. Passing ms puts the mtime ~31 000 years out
    // and every freshness compare silently answers "fresh".
    await NodeFSP.utimes(filePath, mtimeMs / 1000, mtimeMs / 1000);
  });

export const commandTypes = (commands: ReadonlyArray<OrchestrationCommand>): string[] =>
  commands.map((c) => c.type);

export const turnStarts = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter(
    (c): c is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
      c.type === "thread.turn.start",
  );

export interface AppendedActivity {
  readonly kind: string;
  readonly tone: string;
  readonly summary: string;
  readonly payload: unknown;
  readonly threadId: string;
}

export const activities = (
  commands: ReadonlyArray<OrchestrationCommand>,
): ReadonlyArray<AppendedActivity> =>
  commands
    .filter((c) => c.type === "thread.activity.append")
    .map((c) => {
      const command = c as unknown as {
        threadId: string;
        activity: { kind: string; tone: string; summary: string; payload: unknown };
      };
      return { ...command.activity, threadId: command.threadId };
    });

export const activitiesOfKind = (
  commands: ReadonlyArray<OrchestrationCommand>,
  kind: string,
): ReadonlyArray<AppendedActivity> => activities(commands).filter((a) => a.kind === kind);

// --- waiting -----------------------------------------------------------------
//
// Every wait below is an await on a receipt the reactor published. Nothing here counts
// scheduler turns, and nothing here moves the clock except the polls a scenario asks for.
//
// It used to count turns, and that is what three CI failures were: the store persists through
// `writeFileStringAtomically`, real filesystem I/O whose completion fires on the Node event
// loop and not on `TestClock`, so on a two-core runner a turn buys less real progress and a
// budget that is generous on a laptop runs out. The tests then read a half-finished tick as a
// finished one — and because the harness kept advancing, the failures came back as assertions
// about the product (a wake covered twice, a check-in five simulated minutes late) rather than
// as anything that looked like a timing bug. See `receipts.ts`.

/** A real event-loop tick. */
const realTick = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

/** One pump of both schedulers: the Effect fiber scheduler and the real Node event loop. */
export const pump = Effect.gen(function* () {
  yield* realTick;
  for (let j = 0; j < 5; j++) yield* Effect.yieldNow;
});

/**
 * A bounded spin, for asserting that something does NOT happen.
 *
 * The only wait left that is not a receipt, because you cannot await the absence of one. It
 * moves no clock, so the worst a starved runner can do here is make the assertion weaker —
 * never make it wrong. Anything waiting for something to APPEAR must await its receipt.
 */
export const settleQuiet = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* pump;
});

/** The next receipt matching `matches`. Unbounded on purpose: the test timeout is the bound. */
export const untilReceipt = (matches: (receipt: LoopReactorReceipt) => boolean) =>
  Effect.gen(function* () {
    const { log } = yield* LoopReactorReceipts;
    while (true) {
      const receipt = yield* PubSub.take(log);
      if (matches(receipt)) return receipt;
    }
  });

/**
 * Wait until every matcher has seen a receipt, in any order.
 *
 * One drain serves all of them, because a second `untilReceipt` would have thrown away the
 * receipt the first one was not looking for.
 */
export const untilAllReceipts = (
  matchers: ReadonlyArray<(receipt: LoopReactorReceipt) => boolean>,
) =>
  Effect.gen(function* () {
    const { log } = yield* LoopReactorReceipts;
    const outstanding = [...matchers];
    while (outstanding.length > 0) {
      const receipt = yield* PubSub.take(log);
      const index = outstanding.findIndex((matches) => matches(receipt));
      if (index >= 0) outstanding.splice(index, 1);
    }
  });

/**
 * Advance one poll and wait for the tick it triggers to finish.
 *
 * `tick.completed` is published after every armed thread has been evaluated and every write
 * is durable, so when this returns the world is exactly one whole tick further on — no more
 * and no less, on any machine. Receipts from earlier in the tick are drained on the way past.
 */
const advanceOnePoll = (log: PubSub.Subscription<LoopReactorReceipt>) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(Duration.millis(POLL_MS));
    while (true) {
      const receipt = yield* PubSub.take(log);
      if (receipt.type === "tick.completed") return receipt;
    }
  });

/**
 * One real turn before the first poll, so a tick fiber that was forked but has not started
 * yet reaches its `Effect.sleep` before the clock steps over it. Turns, never time.
 */
const reactorSleeping = realTick;

/** Advance the clock by whole poll intervals, waiting out each tick. */
export const advancePolls = (polls: number) =>
  Effect.gen(function* () {
    const { log } = yield* LoopReactorReceipts;
    yield* reactorSleeping;
    for (let i = 0; i < polls; i++) yield* advanceOnePoll(log);
  });

/**
 * Advance the clock in poll-sized steps until `condition` holds.
 *
 * The condition is evaluated once per *completed* tick, so it can never see a half-finished
 * one and the clock's resting place is a property of the scenario alone. `maxPolls` bounds
 * simulated time — how long the scenario is willing to wait — and nothing about the machine.
 */
export const advanceUntil = (
  condition: Effect.Effect<boolean>,
  description: string,
  maxPolls = 600,
) =>
  Effect.gen(function* () {
    const { log } = yield* LoopReactorReceipts;
    yield* reactorSleeping;
    for (let poll = 0; poll < maxPolls; poll++) {
      if (yield* condition) return;
      yield* advanceOnePoll(log);
    }
    if (yield* condition) return;
    return yield* Effect.die(
      new Error(`timed out waiting for ${description} after ${maxPolls} polls`),
    );
  });

/**
 * Move the clock with no reactor to wait for.
 *
 * Only correct where the supervisor is switched off and no tick will ever complete: awaiting
 * a receipt that cannot come would hang instead of asserting.
 */
export const advanceWithoutReactor = (polls: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < polls; i++) {
      yield* TestClock.adjust(Duration.millis(POLL_MS));
      yield* settleQuiet;
    }
  });

/** `true` once at least `n` turn starts have been dispatched. */
export const turnStartsAtLeast = (dispatched: Ref.Ref<OrchestrationCommand[]>, n: number) =>
  Ref.get(dispatched).pipe(Effect.map((all) => turnStarts(all).length >= n));

/** `true` once the record has a terminal state. */
export const isStopped = (store: {
  readonly getThread: (id: string) => Effect.Effect<{ stopped: unknown }>;
}) => store.getThread(LOOP_THREAD_ID).pipe(Effect.map((record) => record.stopped !== null));
