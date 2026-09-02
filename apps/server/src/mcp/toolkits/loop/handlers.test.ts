// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off -- fixture timestamps anchored on a fixed constant, never
// a wall-clock reading.
/**
 * TESTS.md §7, cases 108–118h: the question channel.
 *
 * The tools are driven through a real `McpServer` rather than by calling the handler
 * functions, because half of what is under test is the registration and the attribution: a
 * handler invoked directly would be handed an `McpInvocationContext` by the test, which is
 * exactly the thing that must come from the credential instead.
 */

import { EnvironmentId, ProviderInstanceId, ThreadId, UserInputQuestion } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/unstable/ai";
import * as NodePath from "node:path";

import { resolveConfig } from "../../../coil/loop/config.ts";
import { doneSignal, evaluateGuards, stopCondition } from "../../../coil/loop/guards.ts";
import {
  DEFAULT_GLOBAL_SETTINGS,
  EMPTY_RECORD,
  LoopStore,
  type LoopStoreShape,
  makeLoopStore,
  type UserInputRecord,
} from "../../../coil/loop/state.ts";
import type { LoopGuardInput, LoopThreadShell } from "../../../coil/loop/types.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { LoopToolkitHandlersLive, MAX_OPEN_BLOCKERS_PER_WINDOW } from "./handlers.ts";
import { LoopToolkit } from "./tools.ts";

const decodeUserInputQuestion = Schema.decodeUnknownEffect(UserInputQuestion);

const NOW = 1_800_000_000_000; // 2027-01-15T08:00:00Z
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const THREAD = "thread-loop-mcp";
const OTHER_THREAD = "thread-someone-else";

const invocation = (threadId: string) => ({
  environmentId: EnvironmentId.make("environment-loop-test"),
  threadId: ThreadId.make(threadId),
  providerSessionId: "provider-session-loop-test",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  // The loop tools are ungated by design: nothing consults `capabilities`, and the real
  // gate is `global.enabled` plus the armed record. An empty set proves that.
  capabilities: new Set<McpInvocationContext.McpCapability>(),
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "loop-toolkit-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

/** Registers the toolkit against a store the test controls, on one shared `McpServer`. */
const toolkitLayer = (store: LoopStoreShape) =>
  McpServer.toolkit(LoopToolkit).pipe(
    Layer.provide(LoopToolkitHandlersLive),
    Layer.provide(Layer.succeed(LoopStore, store)),
    Layer.provideMerge(McpServer.McpServer.layer),
  );

/**
 * A tool call as the transport makes it: arguments in, invocation context provided
 * separately by the authenticated middleware.
 */
const callTool = (name: string, args: Record<string, unknown>, threadId = THREAD) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(threadId)),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

const structured = (result: McpSchema.CallToolResult) =>
  result.structuredContent as Record<string, unknown>;

const armed = (store: LoopStoreShape, threadId = THREAD) =>
  store.arm({
    threadId,
    armedAtMs: NOW - 2 * HOUR,
    deadlineAtMs: NOW + 4 * HOUR,
    maxCheckIns: 6,
  });

/** The default world: loops on machine-wide, one armed thread, virtual clock at NOW. */
const withTools = <A, E>(
  body: (store: LoopStoreShape) => Effect.Effect<A, E, McpServer.McpServer>,
  seed: (store: LoopStoreShape) => Effect.Effect<unknown> = (store) =>
    store.setGlobal({ enabled: true }).pipe(Effect.andThen(armed(store))),
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "coil-loop-mcp-" });
    const store = yield* makeLoopStore(NodePath.join(root, "coil-loop.json"));
    yield* seed(store);
    yield* TestClock.setTime(NOW);
    return yield* body(store).pipe(Effect.provide(toolkitLayer(store)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.orDie);

// --- pure-side fixtures -----------------------------------------------------

const shell = (o: Partial<LoopThreadShell> = {}): LoopThreadShell =>
  ({
    updatedAt: new Date(NOW - 20 * MINUTE).toISOString(),
    archivedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    session: null,
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...o,
  }) as unknown as LoopThreadShell;

const guardInput = (o: Partial<LoopGuardInput> = {}): LoopGuardInput => ({
  nowMs: NOW,
  processStartedAtMs: NOW - 24 * HOUR,
  record: {
    ...EMPTY_RECORD,
    armed: true,
    armedAtMs: NOW - 2 * HOUR,
    maxCheckIns: 6,
    checkInsUsed: 2,
    deadlineAtMs: NOW + 4 * HOUR,
  },
  global: { ...DEFAULT_GLOBAL_SETTINGS, enabled: true },
  shell: shell(),
  sentinelAtMs: null,
  loopDoneAtMs: null,
  autoResumePending: false,
  armedCount: 1,
  config: resolveConfig({}),
  trigger: { idleForMs: 20 * MINUTE, thresholdMs: 15 * MINUTE, busyTurn: false, wake: null },
  ...o,
});

describe("raise_blocker", () => {
  it.effect("108. returns immediately — it awaits nothing but its own write", () =>
    withTools((store) =>
      Effect.gen(function* () {
        // Standing in for the `Deferred` `AskUserQuestion` parks the turn on. If
        // `raise_blocker` ever waits for an answer this test deadlocks and the suite goes
        // red, which is the only assertion that actually protects the design.
        const answer = yield* Deferred.make<string>();

        const before = yield* Clock.currentTimeMillis;
        const result = yield* callTool("raise_blocker", { question: "Migration or shim?" });
        const after = yield* Clock.currentTimeMillis;

        assert.strictEqual(after - before, 0);
        assert.isFalse(yield* Deferred.isDone(answer));
        expect(structured(result)).toMatchObject({ status: "recorded" });
        assert.lengthOf(yield* store.listOpenBlockers(THREAD), 1);
      }),
    ),
  );

  it.effect("109. attributes the blocker to the calling thread, never to an argument", () =>
    withTools(
      (store) =>
        Effect.gen(function* () {
          // A `threadId` in the payload is stripped by the parameter schema before a
          // handler ever sees it, so it cannot redirect a question at another thread.
          yield* callTool("raise_blocker", {
            question: "Whose thread is this?",
            threadId: OTHER_THREAD,
          });

          assert.lengthOf(yield* store.listOpenBlockers(THREAD), 1);
          assert.lengthOf(yield* store.listOpenBlockers(OTHER_THREAD), 0);
        }),
      (store) =>
        store
          .setGlobal({ enabled: true })
          .pipe(Effect.andThen(armed(store)), Effect.andThen(armed(store, OTHER_THREAD))),
    ),
  );

  it.effect("110. records a free-text blocker when no options are given", () =>
    withTools((store) =>
      Effect.gen(function* () {
        yield* callTool("raise_blocker", { question: "  What should the default be?  " });

        const [blocker] = yield* store.listOpenBlockers(THREAD);
        expect(blocker).toMatchObject({
          question: "What should the default be?",
          options: [],
          context: null,
          answeredAtMs: null,
          deliveredToAgent: false,
        });
      }),
    ),
  );

  it.effect("111. shapes options so the console renders them as a UserInputQuestion", () =>
    withTools((store) =>
      Effect.gen(function* () {
        yield* callTool("raise_blocker", {
          question: "Migration or shim?",
          options: [
            { label: "migration", description: " slower, correct " },
            { label: "  ", description: "unusable, dropped" },
          ],
          context: "packages/contracts/src/settings.ts",
        });

        const [blocker] = yield* store.listOpenBlockers(THREAD);
        assert.isDefined(blocker);
        // The real proof: the recorded options decode as the contract's own question type,
        // so the console can hand them to the native component rather than a second widget.
        const question = yield* decodeUserInputQuestion({
          id: blocker.id,
          header: "Blocker",
          question: blocker.question,
          options: blocker.options,
        });
        expect(question.options).toEqual([{ label: "migration", description: "slower, correct" }]);
        assert.strictEqual(blocker.context, "packages/contracts/src/settings.ts");
      }),
    ),
  );

  it.effect("112. records a blocker from a thread with no armed loop", () =>
    withTools(
      (store) =>
        Effect.gen(function* () {
          const result = yield* callTool("raise_blocker", { question: "Still worth asking?" });

          expect(structured(result)).toMatchObject({ status: "recorded" });
          assert.lengthOf(yield* store.listOpenBlockers(THREAD), 1);
          assert.isFalse((yield* store.getThread(THREAD)).armed);
        }),
      (store) => store.setGlobal({ enabled: true }),
    ),
  );

  it.effect("113. reports the cap back to the agent rather than dropping the question", () =>
    withTools((store) =>
      Effect.gen(function* () {
        for (let n = 0; n < MAX_OPEN_BLOCKERS_PER_WINDOW; n += 1) {
          const accepted = yield* callTool("raise_blocker", { question: `question ${n}` });
          expect(structured(accepted)).toMatchObject({ status: "recorded" });
        }

        const capped = yield* callTool("raise_blocker", { question: "one too many" });

        expect(structured(capped)).toMatchObject({
          status: "capped",
          id: null,
          openBlockers: MAX_OPEN_BLOCKERS_PER_WINDOW,
          cap: MAX_OPEN_BLOCKERS_PER_WINDOW,
        });
        assert.include(String(structured(capped).detail), "Not recorded");
        assert.lengthOf(yield* store.listOpenBlockers(THREAD), MAX_OPEN_BLOCKERS_PER_WINDOW);
      }),
    ),
  );

  it.effect("113b. answering frees cap budget, so the channel is never exhausted for good", () =>
    withTools((store) =>
      Effect.gen(function* () {
        for (let n = 0; n < MAX_OPEN_BLOCKERS_PER_WINDOW; n += 1) {
          yield* callTool("raise_blocker", { question: `question ${n}` });
        }
        const open = yield* store.listOpenBlockers(THREAD);
        yield* store.answerBlocker(THREAD, open[0]!.id, "take the migration", NOW + MINUTE);

        const result = yield* callTool("raise_blocker", { question: "room again" });

        expect(structured(result)).toMatchObject({ status: "recorded" });
      }),
    ),
  );

  it.effect("118. is unavailable, in-band, when the master toggle is off", () =>
    withTools(
      (store) =>
        Effect.gen(function* () {
          const result = yield* callTool("raise_blocker", { question: "anyone home?" });

          expect(structured(result)).toMatchObject({ status: "unavailable", id: null });
          assert.lengthOf(yield* store.listOpenBlockers(THREAD), 0);
        }),
      (store) => store.setGlobal({ enabled: false }).pipe(Effect.andThen(armed(store))),
    ),
  );

  it.effect("118g. cannot record anything without an invocation context", () =>
    withTools((store) =>
      Effect.gen(function* () {
        // With `enableAgentBrowserAccess` off, `ProviderService.prepareMcpSession` revokes
        // the credential and mints none, so `/mcp` 401s and no invocation context is ever
        // provided. This is that state at the tool boundary: there is no unattributed path,
        // so the tools simply vanish rather than writing against a guessed thread.
        const exit = yield* McpServer.McpServer.pipe(
          Effect.flatMap((server) =>
            server.callTool({ name: "raise_blocker", arguments: { question: "no credential" } }),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.exit,
        );

        // The server turns the missing service into an error result with no structured
        // content: the agent is told the tool failed, and nothing is written against a
        // guessed thread. That is the whole of "the tools vanish".
        assert.strictEqual(exit._tag, "Success");
        const result = exit._tag === "Success" ? exit.value : null;
        assert.isTrue(result?.isError);
        assert.isUndefined(result?.structuredContent);
        assert.lengthOf(yield* store.listOpenBlockers(THREAD), 0);
      }),
    ),
  );
});

describe("loop_status", () => {
  it.effect("114. reports the true remaining budget and deadline", () =>
    withTools(
      () =>
        Effect.gen(function* () {
          const result = yield* callTool("loop_status", {});

          expect(structured(result)).toEqual({
            armed: true,
            reason: null,
            state: "watching",
            checkInsUsed: 2,
            maxCheckIns: 6,
            deadlineAtMs: NOW + 4 * HOUR,
            msToDeadline: 4 * HOUR,
            blockersOpen: 1,
          });
        }),
      (store) =>
        store.setGlobal({ enabled: true }).pipe(
          Effect.andThen(armed(store)),
          Effect.andThen(
            store.recordCheckIn({
              threadId: THREAD,
              firedAtMs: NOW - 90 * MINUTE,
              createdAtIso: "2027-01-15T06:30:00.000Z",
              activityCursor: "act-1",
            }),
          ),
          Effect.andThen(
            store.recordCheckIn({
              threadId: THREAD,
              firedAtMs: NOW - 45 * MINUTE,
              createdAtIso: "2027-01-15T07:15:00.000Z",
              activityCursor: "act-2",
            }),
          ),
          Effect.andThen(
            store.addBlocker(THREAD, {
              id: "b-1",
              raisedAtMs: NOW - 40 * MINUTE,
              question: "still open",
              options: [],
              context: null,
              answeredAtMs: null,
              answer: null,
              deliveredToAgent: false,
            }),
          ),
        ),
    ),
  );

  it.effect("115. answers no-loop rather than failing on an unsupervised thread", () =>
    withTools(
      () =>
        Effect.gen(function* () {
          const result = yield* callTool("loop_status", {});

          assert.isFalse(result.isError);
          expect(structured(result)).toMatchObject({
            armed: false,
            reason: "no-loop",
            state: "off",
            checkInsUsed: 0,
            maxCheckIns: 0,
            msToDeadline: 0,
            blockersOpen: 0,
          });
        }),
      (store) => store.setGlobal({ enabled: true }),
    ),
  );

  it.effect("118. answers rather than failing when the master toggle is off", () =>
    withTools(
      () =>
        Effect.gen(function* () {
          const result = yield* callTool("loop_status", {});

          assert.isFalse(result.isError);
          expect(structured(result)).toMatchObject({
            armed: false,
            reason: "disabled",
            state: "standing_down",
          });
        }),
      (store) => store.setGlobal({ enabled: false }).pipe(Effect.andThen(armed(store))),
    ),
  );
});

describe("loop_done", () => {
  it.effect("116. sets exactly the signal the reactor's stop sweep reads", () =>
    withTools((store) =>
      Effect.gen(function* () {
        const result = yield* callTool("loop_done", { reason: "migration landed" });

        expect(structured(result)).toMatchObject({ ok: true, status: "recorded" });
        const record = yield* store.getThread(THREAD);
        assert.strictEqual(record.loopDoneAtMs, NOW);
        assert.strictEqual(record.loopDoneReason, "migration landed");

        // `doneSignal` is the predicate the reactor feeds from the record. Asserting on it
        // rather than on a field name is what keeps this test honest if the plumbing moves.
        expect(
          doneSignal({ record, sentinelAtMs: null, loopDoneAtMs: record.loopDoneAtMs }),
        ).toEqual({ cause: "loop_done", atMs: NOW });
        expect(
          stopCondition({
            nowMs: NOW,
            record,
            shell: shell(),
            sentinelAtMs: null,
            loopDoneAtMs: record.loopDoneAtMs,
          }),
        ).toMatchObject({ kind: "stop", outcome: "done", cause: "loop_done" });
      }),
    ),
  );

  it.effect("116b. is equivalent to the done-file: same outcome, same freshness rule", () =>
    withTools((store) =>
      Effect.gen(function* () {
        yield* callTool("loop_done", { reason: "done here" });
        const record = yield* store.getThread(THREAD);

        const viaTool = stopCondition({
          nowMs: NOW,
          record,
          shell: shell(),
          sentinelAtMs: null,
          loopDoneAtMs: record.loopDoneAtMs,
        });
        const viaFile = stopCondition({
          nowMs: NOW,
          record: { ...record, loopDoneAtMs: null },
          shell: shell(),
          sentinelAtMs: NOW,
          loopDoneAtMs: null,
        });
        assert.strictEqual(viaTool?.outcome, viaFile?.outcome);
        assert.strictEqual(viaTool?.outcome, "done");

        // Same freshness rule as a leftover `.coil/loop-done`: a call from a previous run
        // does not end the next one, because a re-arm takes a newer `armedAtMs`.
        const rearmed = { ...record, armedAtMs: NOW + MINUTE };
        expect(
          doneSignal({ record: rearmed, sentinelAtMs: null, loopDoneAtMs: record.loopDoneAtMs }),
        ).toBeNull();
      }),
    ),
  );

  it.effect("116c. the whole guard table stops the run once the signal is set", () =>
    withTools((store) =>
      Effect.gen(function* () {
        yield* callTool("loop_done", { reason: "all finished" });
        const record = yield* store.getThread(THREAD);

        expect(evaluateGuards(guardInput({ record, loopDoneAtMs: record.loopDoneAtMs }))).toEqual({
          kind: "stop",
          guard: "4b",
          outcome: "done",
          cause: "loop_done",
          detail: `loop_done at ${NOW}`,
        });
      }),
    ),
  );

  it.effect("117. is a no-op, not a crash, from a thread with no loop", () =>
    withTools(
      (store) =>
        Effect.gen(function* () {
          const result = yield* callTool("loop_done", { reason: "nothing to end" });

          assert.isFalse(result.isError);
          expect(structured(result)).toMatchObject({ ok: true, status: "no-loop" });
          assert.strictEqual((yield* store.getThread(THREAD)).loopDoneAtMs, null);
        }),
      (store) => store.setGlobal({ enabled: true }),
    ),
  );

  it.effect("118. records nothing when the master toggle is off", () =>
    withTools(
      (store) =>
        Effect.gen(function* () {
          const result = yield* callTool("loop_done", { reason: "toggle is off" });

          expect(structured(result)).toMatchObject({ ok: true, status: "disabled" });
          assert.strictEqual((yield* store.getThread(THREAD)).loopDoneAtMs, null);
        }),
      (store) => store.setGlobal({ enabled: false }).pipe(Effect.andThen(armed(store))),
    ),
  );
});

describe("118h. a session-resume dialog the loop caused itself", () => {
  const resumeReturn: UserInputRecord = {
    requestId: "req-resume-1",
    raisedAtMs: NOW - 4 * HOUR,
    dialogKind: "resume_return",
    question: "Resume this session?",
    resolution: null,
    resolvedAtMs: null,
  };

  it.effect("keeps the non-blocking channel open while the turn is parked on the dialog", () =>
    withTools(
      (store) =>
        Effect.gen(function* () {
          // The point of `raise_blocker`: the blocking channel is occupied by a dialog the
          // check-in itself triggered, and the agent can still bank a question and read its
          // budget without waiting on anyone.
          const raised = yield* callTool("raise_blocker", { question: "parked, still asking" });
          const status = yield* callTool("loop_status", {});

          expect(structured(raised)).toMatchObject({ status: "recorded" });
          expect(structured(status)).toMatchObject({ armed: true, blockersOpen: 1 });
          const record = yield* store.getThread(THREAD);
          assert.strictEqual(record.userInputs[0]?.dialogKind, "resume_return");
        }),
      (store) =>
        store
          .setGlobal({ enabled: true })
          .pipe(
            Effect.andThen(armed(store)),
            Effect.andThen(store.recordUserInput(THREAD, resumeReturn)),
          ),
    ),
  );

  it("guard 8 still skips, spends nothing, and the run ends spent rather than stalled", () => {
    const parked = shell({ hasPendingUserInput: true });
    const record = {
      ...guardInput().record,
      checkInsUsed: 1,
      strikes: 0,
      userInputs: [resumeReturn],
    };

    // Parked: a non-consuming stand-down, so the budget is untouched however long it sits.
    expect(evaluateGuards(guardInput({ record, shell: parked }))).toMatchObject({
      kind: "stand_down",
      guard: "8",
      reason: "pending_user_input",
    });

    // And when the deadline arrives it is `spent` — never `stalled`, which would blame the
    // agent for a dialog it was never given the chance to answer.
    expect(
      evaluateGuards(guardInput({ record, shell: parked, nowMs: record.deadlineAtMs + MINUTE })),
    ).toMatchObject({ kind: "stop", outcome: "spent", cause: "deadline" });
  });
});
