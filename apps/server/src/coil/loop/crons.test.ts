// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDateInEffect:off - reads back the wall clock of an explicit
// timestamp the hook already computed; no ambient time is sampled.
import * as NodePath from "node:path";

import type {
  HookInput,
  StopHookInput,
  SubagentStopHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { loopHooksFor, type LoopHookRun, type LoopHooks, makeLoopHooks } from "./crons.ts";
import { LoopStore, type LoopStoreShape, makeLoopStore } from "./state.ts";

const THREAD_ID = "thread-loop-1";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

// The SDK hook contract is a Promise, so the test runner has to be one too. In production
// this is the adapter's own runtime (`Effect.runPromiseWith`), which is what puts hook
// logs on the session that owns them.
const run: LoopHookRun = Effect.runPromise;

const notAborted = { signal: new AbortController().signal };

const abortedOptions = () => {
  const controller = new AbortController();
  controller.abort();
  return { signal: controller.signal };
};

const baseInput = {
  session_id: "session-1",
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/tmp/workspace",
};

/**
 * `session_crons` is deliberately `unknown`: the whole point of these cases is what the fork
 * does with a payload it did not author, including one that omits the field entirely.
 */
const stopInput = (sessionCrons?: unknown): HookInput =>
  ({
    ...baseInput,
    hook_event_name: "Stop",
    stop_hook_active: false,
    ...(sessionCrons === undefined ? {} : { session_crons: sessionCrons }),
  }) as unknown as StopHookInput;

const subagentStopInput = (sessionCrons?: unknown): HookInput =>
  ({
    ...baseInput,
    hook_event_name: "SubagentStop",
    stop_hook_active: false,
    agent_id: "agent-1",
    agent_transcript_path: "/tmp/agent.jsonl",
    agent_type: "general-purpose",
    ...(sessionCrons === undefined ? {} : { session_crons: sessionCrons }),
  }) as unknown as SubagentStopHookInput;

const postToolUseInput = (toolName: string, toolResponse: unknown): HookInput =>
  ({
    ...baseInput,
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: {},
    tool_response: toolResponse,
    tool_use_id: "toolu_1",
  }) as unknown as HookInput;

const stopCallback = (hooks: LoopHooks) => hooks.Stop![0]!.hooks[0]!;
const subagentStopCallback = (hooks: LoopHooks) => hooks.SubagentStop![0]!.hooks[0]!;
const postToolUseMatcher = (hooks: LoopHooks) => hooks.PostToolUse![0]!;

/**
 * A real store over a temp file, plus the hooks wired to it. `storePath` is handed back so a
 * case can reopen the same file with a second store and prove the record is durable.
 */
const withHooks = <A>(
  f: (context: {
    readonly store: LoopStoreShape;
    readonly hooks: LoopHooks;
    readonly storePath: string;
    readonly reopen: Effect.Effect<LoopStoreShape, never, FileSystem.FileSystem | Path.Path>;
  }) => Effect.Effect<A, never, FileSystem.FileSystem | Path.Path>,
  makeStore: (store: LoopStoreShape) => LoopStoreShape = (store) => store,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "coil-loop-crons-" });
    const storePath = NodePath.join(root, "coil-loop.json");
    const store = yield* makeLoopStore(storePath);
    return yield* f({
      store,
      hooks: makeLoopHooks({ store: makeStore(store), threadId: THREAD_ID, run }),
      storePath,
      reopen: makeLoopStore(storePath),
    });
  }).pipe(Effect.scoped, Effect.orDie, Effect.provide(NodeServices.layer), Effect.runPromise);

describe("coil loop crons hooks", () => {
  it("70b: records populated session_crons, computing nextFireAtMs from each schedule", () =>
    withHooks(({ store, hooks }) =>
      Effect.gen(function* () {
        const output = yield* Effect.promise(() =>
          stopCallback(hooks)(
            stopInput([
              { id: "cron-1", schedule: "*/5 * * * *", recurring: true, prompt: "keep going" },
              { id: "cron-2", schedule: "30 3 * * *", recurring: false, prompt: "one shot" },
            ]),
            undefined,
            notAborted,
          ),
        );
        assert.deepStrictEqual(output, { continue: true });

        const record = yield* store.getThread(THREAD_ID);
        assert.isNotNull(record.crons);
        const crons = record.crons!;
        assert.strictEqual(crons.entries.length, 2);

        const recurring = crons.entries[0]!;
        assert.strictEqual(recurring.id, "cron-1");
        assert.strictEqual(recurring.schedule, "*/5 * * * *");
        assert.strictEqual(recurring.recurring, true);
        assert.isNotNull(recurring.nextFireAtMs);
        // The next match of a five-minute step is strictly ahead and at most a period away.
        assert.isAbove(recurring.nextFireAtMs!, crons.recordedAtMs);
        assert.isAtMost(recurring.nextFireAtMs!, crons.recordedAtMs + 5 * MINUTE_MS);
        assert.strictEqual(new Date(recurring.nextFireAtMs!).getMinutes() % 5, 0);

        // A one-shot's cron fields encode a single instant; the same parse resolves it.
        const oneShot = crons.entries[1]!;
        assert.strictEqual(oneShot.recurring, false);
        assert.isNotNull(oneShot.nextFireAtMs);
        assert.isAbove(oneShot.nextFireAtMs!, crons.recordedAtMs);
        assert.isAtMost(oneShot.nextFireAtMs!, crons.recordedAtMs + 24 * HOUR_MS);
        const fireAt = new Date(oneShot.nextFireAtMs!);
        assert.strictEqual(fireAt.getHours(), 3);
        assert.strictEqual(fireAt.getMinutes(), 30);
      }),
    ));

  it("70b: an unparseable schedule is still recorded, with nextFireAtMs null (no deference)", () =>
    withHooks(({ store, hooks }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          stopCallback(hooks)(
            stopInput([
              { id: "cron-1", schedule: "@daily", recurring: true, prompt: "macro" },
              { id: "cron-2", schedule: "0 9 * * 1-5", recurring: true, prompt: "weekdays" },
            ]),
            undefined,
            notAborted,
          ),
        );

        const crons = (yield* store.getThread(THREAD_ID)).crons!;
        assert.strictEqual(crons.entries.length, 2);
        assert.strictEqual(crons.entries[0]!.nextFireAtMs, null);
        assert.isNotNull(crons.entries[1]!.nextFireAtMs);
      }),
    ));

  it("70c: an empty session_crons array clears the record", () =>
    withHooks(({ store, hooks }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          stopCallback(hooks)(
            stopInput([{ id: "cron-1", schedule: "*/5 * * * *", recurring: true, prompt: "x" }]),
            undefined,
            notAborted,
          ),
        );
        assert.strictEqual((yield* store.getThread(THREAD_ID)).crons!.entries.length, 1);

        yield* Effect.promise(() => stopCallback(hooks)(stopInput([]), undefined, notAborted));

        const crons = (yield* store.getThread(THREAD_ID)).crons;
        // Observed-and-empty, NOT never-observed: the agent stopped self-pacing.
        assert.isNotNull(crons);
        assert.deepStrictEqual(crons!.entries, []);
      }),
    ));

  it("70d: an absent session_crons field leaves the record untouched", () =>
    withHooks(({ store, hooks }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          stopCallback(hooks)(
            stopInput([{ id: "cron-1", schedule: "*/5 * * * *", recurring: true, prompt: "x" }]),
            undefined,
            notAborted,
          ),
        );
        const before = (yield* store.getThread(THREAD_ID)).crons;

        yield* Effect.promise(() => stopCallback(hooks)(stopInput(), undefined, notAborted));

        assert.deepStrictEqual((yield* store.getThread(THREAD_ID)).crons, before);
      }),
    ));

  it("70d: a never-observed thread stays null when the field is absent", () =>
    withHooks(({ store, hooks }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => stopCallback(hooks)(stopInput(), undefined, notAborted));
        assert.strictEqual((yield* store.getThread(THREAD_ID)).crons, null);
      }),
    ));

  it("70e: a malformed entry is dropped individually and the rest still record", () =>
    withHooks(({ store, hooks }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          stopCallback(hooks)(
            stopInput([
              null,
              42,
              { schedule: "*/5 * * * *", recurring: true, prompt: "no id" },
              { id: "", schedule: "*/5 * * * *", recurring: true, prompt: "empty id" },
              { id: "cron-blank", schedule: "   ", recurring: true, prompt: "blank schedule" },
              { id: "cron-ok", schedule: "0 3 * * *", recurring: true, prompt: "keeps" },
            ]),
            undefined,
            notAborted,
          ),
        );

        const crons = (yield* store.getThread(THREAD_ID)).crons!;
        assert.deepStrictEqual(
          crons.entries.map((entry) => entry.id),
          ["cron-ok"],
        );
      }),
    ));

  it("70e: a non-array session_crons is treated as absent, not as empty", () =>
    withHooks(({ store, hooks }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          stopCallback(hooks)(
            stopInput([{ id: "cron-1", schedule: "0 3 * * *", recurring: true, prompt: "x" }]),
            undefined,
            notAborted,
          ),
        );

        yield* Effect.promise(() =>
          stopCallback(hooks)(stopInput({ nope: true }), undefined, notAborted),
        );

        assert.strictEqual((yield* store.getThread(THREAD_ID)).crons!.entries.length, 1);
      }),
    ));

  it("70f: a store that dies still returns continue and writes nothing", () =>
    withHooks(
      ({ store, hooks }) =>
        Effect.gen(function* () {
          const output = yield* Effect.promise(() =>
            stopCallback(hooks)(
              stopInput([{ id: "cron-1", schedule: "0 3 * * *", recurring: true, prompt: "x" }]),
              undefined,
              notAborted,
            ),
          );
          // No `decision`, no `continue: false` — a Stop hook can halt a turn and this one
          // never may, whatever the fork's own bookkeeping did.
          assert.deepStrictEqual(output, { continue: true });
          assert.strictEqual((yield* store.getThread(THREAD_ID)).crons, null);
        }),
      (store) => ({
        ...store,
        setCrons: () =>
          Effect.sync(() => {
            throw new Error("simulated store defect");
          }),
      }),
    ));

  it("70f: a store that throws synchronously still returns continue", () =>
    withHooks(
      ({ hooks }) =>
        Effect.gen(function* () {
          const output = yield* Effect.promise(() =>
            stopCallback(hooks)(
              stopInput([{ id: "cron-1", schedule: "0 3 * * *", recurring: true, prompt: "x" }]),
              undefined,
              notAborted,
            ),
          );
          assert.deepStrictEqual(output, { continue: true });
        }),
      (store) => ({
        ...store,
        setCrons: () => {
          throw new Error("simulated synchronous throw");
        },
      }),
    ));

  it("70f: an already-aborted signal returns continue and records nothing", () =>
    withHooks(({ store, hooks }) =>
      Effect.gen(function* () {
        const output = yield* Effect.promise(() =>
          stopCallback(hooks)(
            stopInput([{ id: "cron-1", schedule: "0 3 * * *", recurring: true, prompt: "x" }]),
            undefined,
            abortedOptions(),
          ),
        );
        assert.deepStrictEqual(output, { continue: true });
        assert.strictEqual((yield* store.getThread(THREAD_ID)).crons, null);
      }),
    ));

  it("70f: every matcher carries a timeout so a wedged callback cannot stall a turn", () =>
    withHooks(({ hooks }) =>
      Effect.sync(() => {
        for (const matchers of [hooks.Stop, hooks.SubagentStop, hooks.PostToolUse]) {
          assert.isDefined(matchers);
          for (const matcher of matchers!) {
            assert.isAbove(matcher.timeout ?? 0, 0);
          }
        }
      }),
    ));

  it("70g: SubagentStop is handled identically to Stop", () =>
    withHooks(({ store, hooks }) =>
      Effect.gen(function* () {
        const output = yield* Effect.promise(() =>
          subagentStopCallback(hooks)(
            subagentStopInput([
              { id: "cron-sub", schedule: "*/10 * * * *", recurring: true, prompt: "sub" },
            ]),
            undefined,
            notAborted,
          ),
        );
        assert.deepStrictEqual(output, { continue: true });

        const crons = (yield* store.getThread(THREAD_ID)).crons!;
        assert.deepStrictEqual(
          crons.entries.map((entry) => entry.id),
          ["cron-sub"],
        );
        assert.isNotNull(crons.entries[0]!.nextFireAtMs);

        // And SubagentStop clears on empty, exactly as Stop does.
        yield* Effect.promise(() =>
          subagentStopCallback(hooks)(subagentStopInput([]), undefined, notAborted),
        );
        assert.deepStrictEqual((yield* store.getThread(THREAD_ID)).crons!.entries, []);
      }),
    ));

  it("70h: the record survives a store round-trip", () =>
    withHooks(({ store, hooks, reopen }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          stopCallback(hooks)(
            stopInput([{ id: "cron-1", schedule: "0 3 * * *", recurring: true, prompt: "night" }]),
            undefined,
            notAborted,
          ),
        );
        const written = (yield* store.getThread(THREAD_ID)).crons;

        const rehydrated = yield* reopen;
        assert.deepStrictEqual((yield* rehydrated.getThread(THREAD_ID)).crons, written);
      }),
    ));

  it("70i: the binary's truncated prompt round-trips verbatim", () =>
    withHooks(({ store, hooks }) =>
      Effect.gen(function* () {
        // Exactly what the binary sends: capped at 1000 chars with its own clip marker.
        const truncated = `${"a".repeat(982)}… [+412 chars]`;
        assert.strictEqual(truncated.length, 996);

        yield* Effect.promise(() =>
          stopCallback(hooks)(
            stopInput([
              { id: "cron-1", schedule: "0 3 * * *", recurring: true, prompt: truncated },
            ]),
            undefined,
            notAborted,
          ),
        );

        const entry = (yield* store.getThread(THREAD_ID)).crons!.entries[0]!;
        assert.strictEqual(entry.prompt, truncated);
      }),
    ));

  it("70j: a ScheduleWakeup response containing the gate marker sets degraded", () =>
    withHooks(({ store, hooks }) =>
      Effect.gen(function* () {
        const matcher = postToolUseMatcher(hooks);
        assert.strictEqual(matcher.matcher, "ScheduleWakeup");

        const output = yield* Effect.promise(() =>
          matcher.hooks[0]!(
            postToolUseInput("ScheduleWakeup", {
              status: "error",
              detail: "scheduler unavailable: GATE_OFF",
            }),
            undefined,
            notAborted,
          ),
        );
        assert.deepStrictEqual(output, { continue: true });
        assert.strictEqual((yield* store.getThread(THREAD_ID)).degraded, "gate_off");
      }),
    ));

  it("70k: a response without the marker leaves degraded untouched", () =>
    withHooks(({ store, hooks }) =>
      Effect.gen(function* () {
        yield* store.setDegraded(THREAD_ID, "wake_lost");

        yield* Effect.promise(() =>
          postToolUseMatcher(hooks).hooks[0]!(
            postToolUseInput("ScheduleWakeup", { status: "ok", wakeAt: "2026-09-02T03:00:00Z" }),
            undefined,
            notAborted,
          ),
        );

        // A successful call must never clear an unrelated degraded state by accident.
        assert.strictEqual((yield* store.getThread(THREAD_ID)).degraded, "wake_lost");
      }),
    ));

  it("70k: an unserializable response finds nothing and behaves like no probe", () =>
    withHooks(({ store, hooks }) =>
      Effect.gen(function* () {
        const circular: Record<string, unknown> = {};
        circular.self = circular;

        const output = yield* Effect.promise(() =>
          postToolUseMatcher(hooks).hooks[0]!(
            postToolUseInput("ScheduleWakeup", circular),
            undefined,
            notAborted,
          ),
        );
        assert.deepStrictEqual(output, { continue: true });
        assert.strictEqual((yield* store.getThread(THREAD_ID)).degraded, null);
      }),
    ));

  it("70k: a different tool reaching the callback is ignored", () =>
    withHooks(({ store, hooks }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          postToolUseMatcher(hooks).hooks[0]!(
            postToolUseInput("Bash", { stdout: "gate_off" }),
            undefined,
            notAborted,
          ),
        );
        assert.strictEqual((yield* store.getThread(THREAD_ID)).degraded, null);
      }),
    ));
});

describe("loopHooksFor", () => {
  it("builds nothing when no LoopStore is in context, so the adapter stays hook-free", () =>
    loopHooksFor("thread-1").pipe(
      Effect.map((hooks) => {
        assert.isUndefined(hooks);
      }),
      Effect.runPromise,
    ));

  it("builds the three subscriptions when a LoopStore is available", () =>
    withHooks(({ store }) =>
      Effect.gen(function* () {
        const hooks = yield* loopHooksFor(THREAD_ID).pipe(Effect.provideService(LoopStore, store));
        assert.isDefined(hooks);
        assert.deepStrictEqual(Object.keys(hooks!).sort(), ["PostToolUse", "Stop", "SubagentStop"]);
      }),
    ));

  it("builds nothing when the deployment kill switch is off", () =>
    withHooks(({ store }) =>
      Effect.gen(function* () {
        const previous = process.env.COIL_LOOP_ENABLED;
        process.env.COIL_LOOP_ENABLED = "false";
        try {
          const hooks = yield* loopHooksFor(THREAD_ID).pipe(
            Effect.provideService(LoopStore, store),
          );
          assert.isUndefined(hooks);
        } finally {
          if (previous === undefined) delete process.env.COIL_LOOP_ENABLED;
          else process.env.COIL_LOOP_ENABLED = previous;
        }
      }),
    ));
});
