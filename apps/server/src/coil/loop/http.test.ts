// @effect-diagnostics nodeBuiltinImport:off
/**
 * Route-level tests for the loop API — TESTS.md cases 71–86e.
 *
 * Serves ONLY the fork's route layer over a real HTTP server on an ephemeral port, with
 * `EnvironmentAuth` mocked (`coil/http/testAuth.ts`), a **real** `LoopStore` on a temp file,
 * and stub engine / projection layers that record what was dispatched.
 *
 * The store is real on purpose: half of these cases are assertions that a refusal left the
 * durable record untouched, and a mocked store would assert that the handler did not call a
 * method rather than that the file did not change.
 *
 * `POST /api/coil/loop/answer` (cases 81 and 83) covers the **blocker** half only. Case 82's
 * native half is deliberately absent: a native `AskUserQuestion` is answered through upstream's
 * own composer path, which the console points at rather than cloning — see the route's own note.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { HttpClient, HttpServer } from "effect/unstable/http";
import * as NodePath from "node:path";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  authFails,
  authOk,
  getJson,
  jsonBody,
  postJson,
  runServed,
  serveRoutes,
} from "../http/testAuth.ts";
import { LoopSettingsView, LoopView, loopRouteLayer } from "./http.ts";
import { LoopStore, makeLoopStore, type LoopStoreShape } from "./state.ts";

const PATH = "/api/coil/loop";
const LOOPS_PATH = "/api/coil/loops";
const SETTINGS_PATH = "/api/coil/loop/settings";
const ANSWER_PATH = "/api/coil/loop/answer";

const THREAD_ID = "thread-a";
const PROJECT_ID = ProjectId.make("project-a");

/**
 * Fixed far-future timestamps, so nothing here reads a clock: the routes compare against
 * the real `Clock`, and a literal in 2100 is unambiguously ahead of it.
 */
const FUTURE_DEADLINE = 4_102_444_800_000; // 2100-01-01T00:00:00Z
/** An hour before the deadline: deference applies. */
const WAKE_INSIDE_DEADLINE = FUTURE_DEADLINE - 3_600_000;
const FUTURE_ISO = "2099-01-01T00:00:00.000Z";

const makeThread = (
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: ThreadId.make(id),
  projectId: PROJECT_ID,
  title: id,
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: "2026-09-01T00:00:00.000Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

interface Harness {
  readonly store: LoopStoreShape;
  /** Every command the routes dispatched, in order. */
  readonly dispatched: Array<OrchestrationCommand>;
}

const decodeLoopView = Schema.decodeUnknownEffect(LoopView);
const decodeSettingsView = Schema.decodeUnknownEffect(LoopSettingsView);

const withRoutes = <A, E>(options: {
  readonly auth?: Layer.Layer<EnvironmentAuth.EnvironmentAuth>;
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly body: (
    harness: Harness,
  ) => Effect.Effect<A, E, HttpServer.HttpServer | HttpClient.HttpClient>;
}) =>
  runServed(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "coil-loop-http-" });
      const store = yield* makeLoopStore(NodePath.join(root, "coil-loop.json"));
      const dispatched: Array<OrchestrationCommand> = [];
      const threads = new Map(
        (options.threads ?? [makeThread(THREAD_ID)]).map((thread) => [thread.id as string, thread]),
      );

      const deps = Layer.mergeAll(
        Layer.succeed(LoopStore, store),
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) => {
            dispatched.push(command);
            return Effect.succeed({ sequence: dispatched.length });
          },
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: (threadId) =>
            Effect.succeed(Option.fromUndefinedOr(threads.get(threadId as string))),
        }),
        options.auth ?? authOk([AuthOrchestrationOperateScope]),
      );

      return yield* serveRoutes({
        routes: loopRouteLayer,
        deps,
        body: options.body({ store, dispatched }),
      });
    }),
  );

const armBody = (overrides: Record<string, unknown> = {}) => ({
  threadId: THREAD_ID,
  action: "arm",
  deadlineAtMs: FUTURE_DEADLINE,
  maxCheckIns: 6,
  ...overrides,
});

const pinCommands = (dispatched: ReadonlyArray<OrchestrationCommand>) =>
  dispatched.filter((command) => command.type === "thread.pin" || command.type === "thread.unpin");

describe("/api/coil/loop", () => {
  // 71
  it("rejects a bad credential with a 401", () =>
    withRoutes({
      auth: authFails(new EnvironmentAuth.ServerAuthInvalidCredentialError({})),
      body: () =>
        Effect.gen(function* () {
          assert.strictEqual((yield* getJson(`${PATH}?threadId=${THREAD_ID}`)).status, 401);
          assert.strictEqual((yield* postJson(PATH, armBody())).status, 401);
          assert.strictEqual((yield* getJson(SETTINGS_PATH)).status, 401);
          assert.strictEqual((yield* getJson(LOOPS_PATH)).status, 401);
        }),
    }));

  // 72 — every route is operate scope, including the reads: they describe scheduling.
  it("rejects a read-scope-only session with a 403 on every route", () =>
    withRoutes({
      auth: authOk([AuthOrchestrationReadScope]),
      body: () =>
        Effect.gen(function* () {
          assert.strictEqual((yield* getJson(`${PATH}?threadId=${THREAD_ID}`)).status, 403);
          assert.strictEqual((yield* postJson(PATH, armBody())).status, 403);
          assert.strictEqual((yield* getJson(LOOPS_PATH)).status, 403);
          assert.strictEqual((yield* getJson(SETTINGS_PATH)).status, 403);
          assert.strictEqual((yield* postJson(SETTINGS_PATH, { enabled: true })).status, 403);
        }),
    }));

  // 73 — the console opens on every thread, so "no loop here" must not be an error path.
  it("GET on an unknown thread returns the fail-closed off record, not a 404", () =>
    withRoutes({
      threads: [],
      body: () =>
        Effect.gen(function* () {
          const response = yield* getJson(`${PATH}?threadId=never-seen`);
          assert.strictEqual(response.status, 200);
          const view = yield* decodeLoopView(yield* response.json);
          assert.strictEqual(view.record.armed, false);
          assert.strictEqual(view.record.deadlineAtMs, 0);
          assert.strictEqual(view.record.maxCheckIns, 0);
          assert.strictEqual(view.derived.state, "off");
          assert.strictEqual(view.derived.threadKnown, false);
        }),
    }));

  it("GET without a threadId is a 400", () =>
    withRoutes({
      body: () =>
        Effect.gen(function* () {
          const response = yield* getJson(PATH);
          assert.strictEqual(response.status, 400);
          assert.strictEqual((yield* jsonBody(response)).error, "missing_thread_id");
        }),
    }));

  // 74
  it("POST arm arms the thread and seeds the thresholds from the global defaults", () =>
    withRoutes({
      body: ({ store }) =>
        Effect.gen(function* () {
          const response = yield* postJson(PATH, armBody({ goal: "land the sync" }));
          assert.strictEqual(response.status, 200);
          const view = yield* decodeLoopView(yield* response.json);
          assert.strictEqual(view.record.armed, true);
          assert.strictEqual(view.record.maxCheckIns, 6);
          assert.strictEqual(view.record.deadlineAtMs, FUTURE_DEADLINE);
          assert.strictEqual(view.record.goal, "land the sync");
          assert.strictEqual(view.record.checkInsUsed, 0);
          assert.ok(view.record.armedAtMs > 0, "armedAtMs is the sentinel freshness baseline");

          const global = yield* store.getGlobal;
          assert.strictEqual(view.record.idleMs, global.defaultIdleMs);
          assert.strictEqual(view.record.busyIdleMs, global.defaultBusyIdleMs);

          // The master toggle ships off, so an armed loop reports standing_down until it is
          // flipped on. Arming is still what the user asked for, and nothing is disarmed.
          assert.strictEqual(view.derived.state, "standing_down");
          assert.strictEqual(view.derived.reason, "disabled");
        }),
    }));

  it("POST arm honours explicit thresholds over the defaults", () =>
    withRoutes({
      body: () =>
        Effect.gen(function* () {
          const response = yield* postJson(
            PATH,
            armBody({ idleMs: 5 * 60_000, busyIdleMs: 30 * 60_000 }),
          );
          const view = yield* decodeLoopView(yield* response.json);
          assert.strictEqual(view.record.idleMs, 5 * 60_000);
          assert.strictEqual(view.record.busyIdleMs, 30 * 60_000);
        }),
    }));

  // 75 — a silent clamp hides a mistake in a feature that spends money unattended.
  it("POST arm with a budget over 20 is a 400 and not a clamp", () =>
    withRoutes({
      body: ({ store }) =>
        Effect.gen(function* () {
          const response = yield* postJson(PATH, armBody({ maxCheckIns: 21 }));
          assert.strictEqual(response.status, 400);
          assert.strictEqual((yield* jsonBody(response)).error, "budget_too_large");
          const record = yield* store.getThread(THREAD_ID);
          assert.strictEqual(record.armed, false, "a 400 must not mutate the store");
          assert.strictEqual(record.maxCheckIns, 0, "and must certainly not clamp to 20");
        }),
    }));

  // 76
  it("POST arm with a budget under 1 is a 400", () =>
    withRoutes({
      body: ({ store }) =>
        Effect.gen(function* () {
          const response = yield* postJson(PATH, armBody({ maxCheckIns: 0 }));
          assert.strictEqual(response.status, 400);
          assert.strictEqual((yield* jsonBody(response)).error, "budget_too_small");
          assert.strictEqual((yield* store.getThread(THREAD_ID)).armed, false);
        }),
    }));

  it("POST arm with no budget is a 400 budget_required", () =>
    withRoutes({
      body: () =>
        Effect.gen(function* () {
          const response = yield* postJson(PATH, {
            threadId: THREAD_ID,
            action: "arm",
            deadlineAtMs: FUTURE_DEADLINE,
          });
          assert.strictEqual(response.status, 400);
          assert.strictEqual((yield* jsonBody(response)).error, "budget_required");
        }),
    }));

  // 77
  it("POST arm with a deadline in the past is a 400", () =>
    withRoutes({
      body: ({ store }) =>
        Effect.gen(function* () {
          const response = yield* postJson(PATH, armBody({ deadlineAtMs: 1_000 }));
          assert.strictEqual(response.status, 400);
          assert.strictEqual((yield* jsonBody(response)).error, "deadline_in_past");
          assert.strictEqual((yield* store.getThread(THREAD_ID)).armed, false);
        }),
    }));

  // 77b — the console words "pick an end time" differently from "that time has passed",
  // so the two refusals must not collapse into one bare 400.
  it("POST arm with no deadline is a 400 deadline_required", () =>
    withRoutes({
      body: ({ store }) =>
        Effect.gen(function* () {
          const missing = yield* postJson(PATH, {
            threadId: THREAD_ID,
            action: "arm",
            maxCheckIns: 6,
          });
          assert.strictEqual(missing.status, 400);
          assert.strictEqual((yield* jsonBody(missing)).error, "deadline_required");

          const explicitNull = yield* postJson(PATH, armBody({ deadlineAtMs: null }));
          assert.strictEqual(explicitNull.status, 400);
          assert.strictEqual((yield* jsonBody(explicitNull)).error, "deadline_required");

          assert.strictEqual((yield* store.getThread(THREAD_ID)).deadlineAtMs, 0);
        }),
    }));

  // 78
  it("POST arm at the armed ceiling is a 400 ceiling_reached", () =>
    withRoutes({
      threads: [makeThread("t1"), makeThread("t2"), makeThread("t3"), makeThread("t4")],
      body: ({ store }) =>
        Effect.gen(function* () {
          const global = yield* store.getGlobal;
          for (const threadId of ["t1", "t2", "t3"]) {
            const armed = yield* postJson(PATH, armBody({ threadId }));
            assert.strictEqual(armed.status, 200, `arming ${threadId} within the ceiling`);
          }
          assert.strictEqual(global.maxArmedThreads, 3);

          const refused = yield* postJson(PATH, armBody({ threadId: "t4" }));
          assert.strictEqual(refused.status, 400);
          assert.strictEqual((yield* jsonBody(refused)).error, "ceiling_reached");
          assert.strictEqual((yield* store.getThread("t4")).armed, false);

          // Re-arming a thread that already holds one of the slots is not a new arm, so the
          // ceiling must not refuse it.
          const rearmed = yield* postJson(PATH, armBody({ threadId: "t2", action: "rearm" }));
          assert.strictEqual(rearmed.status, 200);
        }),
    }));

  // 78b — `thread.pin` emits companion unsnoozed/unsettled events, so arming a snoozed
  // thread would silently cancel a snooze a human set. Assert the *absence* of the dispatch.
  it("POST arm on a snoozed thread is a 400 thread_snoozed and dispatches no pin", () =>
    withRoutes({
      threads: [makeThread(THREAD_ID, { snoozedUntil: FUTURE_ISO })],
      body: ({ store, dispatched }) =>
        Effect.gen(function* () {
          const response = yield* postJson(PATH, armBody());
          assert.strictEqual(response.status, 400);
          assert.strictEqual((yield* jsonBody(response)).error, "thread_snoozed");
          assert.deepStrictEqual(pinCommands(dispatched), []);
          assert.strictEqual((yield* store.getThread(THREAD_ID)).armed, false);
        }),
    }));

  it("POST arm on a thread whose snooze has already passed succeeds", () =>
    withRoutes({
      threads: [makeThread(THREAD_ID, { snoozedUntil: "2020-01-01T00:00:00.000Z" })],
      body: () =>
        Effect.gen(function* () {
          assert.strictEqual((yield* postJson(PATH, armBody())).status, 200);
        }),
    }));

  // 78c — arming a settled thread is a promotion the human asked for.
  it("POST arm on a settled thread succeeds and pins it", () =>
    withRoutes({
      threads: [
        makeThread(THREAD_ID, {
          settledOverride: "settled",
          settledAt: "2026-09-01T01:00:00.000Z",
        }),
      ],
      body: ({ store, dispatched }) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* postJson(PATH, armBody())).status, 200);
          const pins = pinCommands(dispatched);
          assert.strictEqual(pins.length, 1);
          assert.strictEqual(pins[0]?.type, "thread.pin");
          assert.strictEqual((yield* store.getThread(THREAD_ID)).pinnedByLoop, true);
        }),
    }));

  // 78d — otherwise disarming removes a pin that was the user's, with nothing recording
  // that it had ever been theirs.
  it("does not unpin a thread the user pinned themselves", () =>
    withRoutes({
      threads: [makeThread(THREAD_ID, { pinnedAt: "2026-08-30T00:00:00.000Z" })],
      body: ({ store, dispatched }) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* postJson(PATH, armBody())).status, 200);
          assert.deepStrictEqual(pinCommands(dispatched), [], "already pinned: no pin needed");
          assert.strictEqual((yield* store.getThread(THREAD_ID)).pinnedByLoop, false);

          const disarmed = yield* postJson(PATH, { threadId: THREAD_ID, action: "disarm" });
          assert.strictEqual(disarmed.status, 200);
          assert.deepStrictEqual(pinCommands(dispatched), [], "and no unpin on the way out");
        }),
    }));

  it("unpins on disarm exactly when the loop created the pin", () =>
    withRoutes({
      body: ({ dispatched }) =>
        Effect.gen(function* () {
          yield* postJson(PATH, armBody());
          yield* postJson(PATH, { threadId: THREAD_ID, action: "disarm" });
          assert.deepStrictEqual(
            pinCommands(dispatched).map((command) => command.type),
            ["thread.pin", "thread.unpin"],
          );
        }),
    }));

  // 79 — takeover disarms and is not a budget reset: deliberately stopping a thread must
  // not hand the next loop a fresh six.
  it("POST disarm writes the handed-back terminal and keeps the budget spent", () =>
    withRoutes({
      body: ({ store }) =>
        Effect.gen(function* () {
          yield* postJson(PATH, armBody());
          yield* store.recordCheckIn({
            threadId: THREAD_ID,
            firedAtMs: 1_000,
            createdAtIso: "2026-09-02T01:00:00.000Z",
            activityCursor: "cursor-1",
          });

          const response = yield* postJson(PATH, { threadId: THREAD_ID, action: "disarm" });
          assert.strictEqual(response.status, 200);
          const view = yield* decodeLoopView(yield* response.json);
          assert.strictEqual(view.record.armed, false);
          assert.strictEqual(view.record.stopped?.reason, "handed-back");
          assert.strictEqual(view.record.checkInsUsed, 1, "disarm is not a budget reset");
          assert.strictEqual(view.derived.state, "stopped");
          assert.strictEqual(view.derived.stoppedReason, "handed-back");
        }),
    }));

  it("POST disarm still works when the thread is gone from the projection", () =>
    withRoutes({
      body: () =>
        Effect.gen(function* () {
          yield* postJson(PATH, armBody());
          // The thread has since been deleted; the way out must not depend on it existing.
          const response = yield* postJson(PATH, { threadId: "never-seen", action: "disarm" });
          assert.strictEqual(response.status, 200);
        }),
    }));

  // 80
  it("POST rearm after a terminal clears it and starts a fresh budget", () =>
    withRoutes({
      body: ({ store }) =>
        Effect.gen(function* () {
          yield* postJson(PATH, armBody());
          yield* store.recordCheckIn({
            threadId: THREAD_ID,
            firedAtMs: 1_000,
            createdAtIso: "2026-09-02T01:00:00.000Z",
            activityCursor: "cursor-1",
          });
          yield* store.stop(THREAD_ID, { reason: "spent", atMs: 2_000, detail: "budget" });

          const response = yield* postJson(
            PATH,
            armBody({ action: "rearm", maxCheckIns: 4, deadlineAtMs: FUTURE_DEADLINE + 1000 }),
          );
          assert.strictEqual(response.status, 200);
          const view = yield* decodeLoopView(yield* response.json);
          assert.strictEqual(view.record.stopped, null);
          assert.strictEqual(view.record.armed, true);
          assert.strictEqual(view.record.checkInsUsed, 0);
          assert.strictEqual(view.record.maxCheckIns, 4);
          assert.deepStrictEqual(view.record.checkIns, []);
          assert.strictEqual(view.record.strikes, 0);
        }),
    }));

  it("POST edit changes the bounds without touching the budget already spent", () =>
    withRoutes({
      body: ({ store }) =>
        Effect.gen(function* () {
          yield* postJson(PATH, armBody());
          yield* store.recordCheckIn({
            threadId: THREAD_ID,
            firedAtMs: 1_000,
            createdAtIso: "2026-09-02T01:00:00.000Z",
            activityCursor: "cursor-1",
          });

          const response = yield* postJson(PATH, {
            threadId: THREAD_ID,
            action: "edit",
            maxCheckIns: 10,
            deadlineAtMs: FUTURE_DEADLINE + 3_600_000,
          });
          const view = yield* decodeLoopView(yield* response.json);
          assert.strictEqual(view.record.maxCheckIns, 10);
          assert.strictEqual(view.record.deadlineAtMs, FUTURE_DEADLINE + 3_600_000);
          assert.strictEqual(view.record.checkInsUsed, 1, "edit is not a re-arm");
          assert.strictEqual(view.record.checkIns.length, 1);
        }),
    }));

  it("POST edit refuses an out-of-range budget with the same codes arming uses", () =>
    withRoutes({
      body: ({ store }) =>
        Effect.gen(function* () {
          yield* postJson(PATH, armBody());
          const response = yield* postJson(PATH, {
            threadId: THREAD_ID,
            action: "edit",
            maxCheckIns: 40,
          });
          assert.strictEqual(response.status, 400);
          assert.strictEqual((yield* jsonBody(response)).error, "budget_too_large");
          assert.strictEqual((yield* store.getThread(THREAD_ID)).maxCheckIns, 6);
        }),
    }));

  // 84
  it("POST with a malformed body is a 400 and mutates nothing", () =>
    withRoutes({
      body: ({ store, dispatched }) =>
        Effect.gen(function* () {
          const malformed = [
            ["no fields at all", { nope: true }],
            ["no action", { threadId: THREAD_ID }],
            ["an action nobody defined", { threadId: THREAD_ID, action: "detonate" }],
            [
              "an empty threadId",
              { threadId: "", action: "arm", deadlineAtMs: FUTURE_DEADLINE, maxCheckIns: 3 },
            ],
          ] as const;
          for (const [label, body] of malformed) {
            const response = yield* postJson(PATH, body);
            assert.strictEqual(response.status, 400, label);
            assert.strictEqual((yield* jsonBody(response)).error, "invalid_body", label);
          }
          assert.strictEqual((yield* store.getThread(THREAD_ID)).armed, false);
          assert.deepStrictEqual(dispatched, []);
        }),
    }));

  // A caller-controlled threadId reaches `Object.hasOwn` in the store. Pinned at the HTTP
  // boundary as well as in the store, because this route is what makes it reachable.
  it("handles a prototype-chain threadId as an ordinary unknown thread", () =>
    withRoutes({
      threads: [],
      body: () =>
        Effect.gen(function* () {
          for (const hostile of ["constructor", "__proto__", "toString"]) {
            const response = yield* getJson(`${PATH}?threadId=${encodeURIComponent(hostile)}`);
            assert.strictEqual(response.status, 200, `GET threadId=${hostile} must not 500`);
            const view = yield* decodeLoopView(yield* response.json);
            assert.strictEqual(view.record.armed, false);
          }
        }),
    }));

  // 85 — the response shapes are the contract with the console; a drift here is a silent
  // client break, since these routes deliberately cost zero `packages/contracts` edits.
  it("every response decodes against its schema", () =>
    withRoutes({
      body: () =>
        Effect.gen(function* () {
          yield* decodeLoopView(yield* jsonBody(yield* postJson(PATH, armBody())));
          yield* decodeLoopView(yield* jsonBody(yield* getJson(`${PATH}?threadId=${THREAD_ID}`)));
          yield* decodeSettingsView(yield* jsonBody(yield* getJson(SETTINGS_PATH)));
          yield* decodeSettingsView(
            yield* jsonBody(yield* postJson(SETTINGS_PATH, { enabled: true })),
          );
          const loops = yield* jsonBody(yield* getJson(LOOPS_PATH));
          assert.ok(Array.isArray(loops.loops));
          for (const loop of loops.loops as ReadonlyArray<unknown>) {
            yield* decodeLoopView(loop);
          }
        }),
    }));

  // 86
  it("GET /api/coil/loops lists every armed loop in a deterministic order", () =>
    withRoutes({
      threads: [makeThread("zeta"), makeThread("alpha"), makeThread("mid")],
      body: () =>
        Effect.gen(function* () {
          // Armed out of alphabetical order: insertion order must not leak into the response.
          for (const threadId of ["zeta", "alpha", "mid"]) {
            yield* postJson(PATH, armBody({ threadId }));
          }
          yield* postJson(PATH, { threadId: "mid", action: "disarm" });

          const response = yield* getJson(LOOPS_PATH);
          assert.strictEqual(response.status, 200);
          const body = yield* jsonBody(response);
          const threadIds: Array<string> = [];
          for (const loop of body.loops as ReadonlyArray<unknown>) {
            threadIds.push((yield* decodeLoopView(loop)).threadId);
          }
          assert.deepStrictEqual(
            threadIds,
            ["alpha", "zeta"],
            "disarmed loops drop out, and the rest are ordered by threadId",
          );
        }),
    }));
});

describe("/api/coil/loop/settings", () => {
  // 86b — the route ships in phase 2 with the reactor. Shipping "default off behind the
  // master toggle" while only the settings UI could flip it left phase 2 unswitchable.
  it("GET returns the fail-closed global block on a fresh install", () =>
    withRoutes({
      body: () =>
        Effect.gen(function* () {
          const response = yield* getJson(SETTINGS_PATH);
          assert.strictEqual(response.status, 200);
          const view = yield* decodeSettingsView(yield* response.json);
          assert.strictEqual(view.enabled, false, "the master toggle defaults OFF");
          assert.strictEqual(view.maxArmedThreads, 3);
          assert.strictEqual(view.defaultMaxCheckIns, 6);
          assert.strictEqual(view.defaultRunMs, 8 * 3_600_000);
          assert.strictEqual(view.defaultIdleMs, 15 * 60_000);
          assert.strictEqual(view.defaultBusyIdleMs, 45 * 60_000);
          assert.strictEqual(view.armedCount, 0);
        }),
    }));

  // 86c — durable, so the next tick observes it rather than a per-process copy.
  it("POST writes the master toggle to the durable store", () =>
    withRoutes({
      body: ({ store }) =>
        Effect.gen(function* () {
          const response = yield* postJson(SETTINGS_PATH, { enabled: true, defaultMaxCheckIns: 8 });
          assert.strictEqual(response.status, 200);
          const view = yield* decodeSettingsView(yield* response.json);
          assert.strictEqual(view.enabled, true);
          assert.strictEqual(view.defaultMaxCheckIns, 8);

          // What the tick fiber would read.
          const global = yield* store.getGlobal;
          assert.strictEqual(global.enabled, true);
          assert.strictEqual(global.defaultMaxCheckIns, 8);
          // Untouched keys survive a partial patch.
          assert.strictEqual(global.maxArmedThreads, 3);

          const reread = yield* decodeSettingsView(yield* jsonBody(yield* getJson(SETTINGS_PATH)));
          assert.strictEqual(reread.enabled, true);
        }),
    }));

  // 86d — the toggle is a guard, not a lifecycle.
  it("toggling off stands loops down without disarming or stopping anything", () =>
    withRoutes({
      body: ({ store }) =>
        Effect.gen(function* () {
          yield* postJson(SETTINGS_PATH, { enabled: true });
          yield* postJson(PATH, armBody());
          yield* store.recordCheckIn({
            threadId: THREAD_ID,
            firedAtMs: 1_000,
            createdAtIso: "2026-09-02T01:00:00.000Z",
            activityCursor: "cursor-1",
          });
          const watching = yield* decodeLoopView(
            yield* jsonBody(yield* getJson(`${PATH}?threadId=${THREAD_ID}`)),
          );
          assert.strictEqual(watching.derived.state, "watching");

          yield* postJson(SETTINGS_PATH, { enabled: false });
          const down = yield* decodeLoopView(
            yield* jsonBody(yield* getJson(`${PATH}?threadId=${THREAD_ID}`)),
          );
          assert.strictEqual(down.derived.state, "standing_down");
          assert.strictEqual(down.derived.reason, "disabled");
          assert.strictEqual(down.record.armed, true, "nothing is disarmed");
          assert.strictEqual(down.record.stopped, null, "nothing is stopped");
          assert.strictEqual(down.record.checkInsUsed, 1, "the budget is untouched");

          yield* postJson(SETTINGS_PATH, { enabled: true });
          const resumed = yield* decodeLoopView(
            yield* jsonBody(yield* getJson(`${PATH}?threadId=${THREAD_ID}`)),
          );
          assert.strictEqual(resumed.derived.state, "watching");
          assert.strictEqual(resumed.record.checkInsUsed, 1, "and resumes with the same budget");
        }),
    }));

  // 86e — same rule as 86d: lowering the ceiling stands the excess down at the next tick
  // rather than manufacturing terminal states nobody chose.
  it("accepts a maxArmedThreads below the current armed count without disarming anything", () =>
    withRoutes({
      threads: [makeThread("t1"), makeThread("t2"), makeThread("t3")],
      body: ({ store }) =>
        Effect.gen(function* () {
          for (const threadId of ["t1", "t2", "t3"]) {
            yield* postJson(PATH, armBody({ threadId }));
          }
          const response = yield* postJson(SETTINGS_PATH, { maxArmedThreads: 1 });
          assert.strictEqual(response.status, 200);
          const view = yield* decodeSettingsView(yield* response.json);
          assert.strictEqual(view.maxArmedThreads, 1);
          assert.strictEqual(view.armedCount, 3, "and reports the overhang honestly");

          const armed = yield* store.listArmed;
          assert.strictEqual(armed.length, 3, "nothing is disarmed by lowering the ceiling");
          for (const entry of armed) {
            assert.strictEqual(entry.record.stopped, null);
          }
        }),
    }));

  it("POST settings out of range is a 400 and writes nothing", () =>
    withRoutes({
      body: ({ store }) =>
        Effect.gen(function* () {
          const refusals = [
            ["a ceiling of zero", { maxArmedThreads: 0 }, "out_of_range"],
            ["a default budget over the cap", { defaultMaxCheckIns: 21 }, "out_of_range"],
            ["a zero idle threshold", { defaultIdleMs: 0 }, "out_of_range"],
            ["a fractional ceiling", { maxArmedThreads: 2.5 }, "invalid_body"],
            ["a toggle that is not a boolean", { enabled: "yes" }, "invalid_body"],
          ] as const;
          for (const [label, body, code] of refusals) {
            const response = yield* postJson(SETTINGS_PATH, body);
            assert.strictEqual(response.status, 400, label);
            assert.strictEqual((yield* jsonBody(response)).error, code, label);
          }
          assert.deepStrictEqual(yield* store.getGlobal, {
            enabled: false,
            maxArmedThreads: 3,
            defaultMaxCheckIns: 6,
            defaultRunMs: 8 * 3_600_000,
            defaultIdleMs: 15 * 60_000,
            defaultBusyIdleMs: 45 * 60_000,
          });
        }),
    }));
});

describe("/api/coil/loop derived state", () => {
  const armedAndEnabled = (harness: Harness) =>
    Effect.gen(function* () {
      yield* postJson(SETTINGS_PATH, { enabled: true });
      yield* postJson(PATH, armBody());
      return harness;
    });

  it("reports held while a usage limit is live", () =>
    withRoutes({
      body: (harness) =>
        Effect.gen(function* () {
          yield* armedAndEnabled(harness);
          yield* harness.store.setRateLimitedUntil(THREAD_ID, FUTURE_DEADLINE);
          const view = yield* decodeLoopView(
            yield* jsonBody(yield* getJson(`${PATH}?threadId=${THREAD_ID}`)),
          );
          assert.strictEqual(view.derived.state, "held");
          assert.strictEqual(view.derived.reason, "rate_limited");
        }),
    }));

  // Guard 8's third clause: a thread parked on an unapproved plan is waiting on a human even
  // though `hasPendingUserInput` is false.
  it("reports blocked on an actionable proposed plan, not just on a pending input", () =>
    withRoutes({
      threads: [makeThread(THREAD_ID, { hasActionableProposedPlan: true })],
      body: (harness) =>
        Effect.gen(function* () {
          yield* armedAndEnabled(harness);
          const view = yield* decodeLoopView(
            yield* jsonBody(yield* getJson(`${PATH}?threadId=${THREAD_ID}`)),
          );
          assert.strictEqual(view.derived.state, "blocked");
          assert.strictEqual(view.derived.reason, "pending_input");
        }),
    }));

  it("reports self_pacing while a recorded wake is still ahead and inside the deadline", () =>
    withRoutes({
      body: (harness) =>
        Effect.gen(function* () {
          yield* armedAndEnabled(harness);
          yield* harness.store.setCrons(THREAD_ID, {
            recordedAtMs: 1_000,
            entries: [
              {
                id: "cron-1",
                schedule: "*/30 * * * *",
                recurring: true,
                prompt: "keep going",
                nextFireAtMs: WAKE_INSIDE_DEADLINE,
              },
            ],
          });
          const view = yield* decodeLoopView(
            yield* jsonBody(yield* getJson(`${PATH}?threadId=${THREAD_ID}`)),
          );
          assert.strictEqual(view.derived.state, "self_pacing");
          assert.strictEqual(view.derived.nextWakeAtMs, WAKE_INSIDE_DEADLINE);
        }),
    }));

  // A wake past the deadline is not deference: `CronCreate` is unbounded, so a run must not
  // stand by for a wake that lands after it was supposed to have ended.
  it("does not defer to a wake scheduled past the deadline", () =>
    withRoutes({
      body: (harness) =>
        Effect.gen(function* () {
          yield* armedAndEnabled(harness);
          yield* harness.store.setCrons(THREAD_ID, {
            recordedAtMs: 1_000,
            entries: [
              {
                id: "cron-1",
                schedule: "0 3 * * *",
                recurring: false,
                prompt: "tomorrow",
                nextFireAtMs: FUTURE_DEADLINE + 3_600_000,
              },
            ],
          });
          const view = yield* decodeLoopView(
            yield* jsonBody(yield* getJson(`${PATH}?threadId=${THREAD_ID}`)),
          );
          assert.strictEqual(view.derived.state, "watching");
        }),
    }));

  // An unparseable schedule means no deference from that entry, never "wake now".
  it("treats an unparsed wake as no deference at all", () =>
    withRoutes({
      body: (harness) =>
        Effect.gen(function* () {
          yield* armedAndEnabled(harness);
          yield* harness.store.setCrons(THREAD_ID, {
            recordedAtMs: 1_000,
            entries: [
              {
                id: "cron-1",
                schedule: "not a cron",
                recurring: false,
                prompt: "?",
                nextFireAtMs: null,
              },
            ],
          });
          const view = yield* decodeLoopView(
            yield* jsonBody(yield* getJson(`${PATH}?threadId=${THREAD_ID}`)),
          );
          assert.strictEqual(view.derived.state, "watching");
          assert.strictEqual(view.derived.nextWakeAtMs, null);
        }),
    }));

  it("keeps a terminal state visible over every live reading", () =>
    withRoutes({
      body: (harness) =>
        Effect.gen(function* () {
          yield* armedAndEnabled(harness);
          yield* harness.store.stop(THREAD_ID, {
            reason: "spent",
            atMs: 2_000,
            detail: "budget exhausted",
          });
          const view = yield* decodeLoopView(
            yield* jsonBody(yield* getJson(`${PATH}?threadId=${THREAD_ID}`)),
          );
          assert.strictEqual(view.derived.state, "stopped");
          assert.strictEqual(view.derived.stoppedReason, "spent", "spent is never done");
        }),
    }));
});

describe("/api/coil/loop/answer", () => {
  const blocker = (overrides: Record<string, unknown> = {}) => ({
    id: "blocker-1",
    raisedAtMs: 1_000,
    question: "Migrate in place or backfill?",
    options: [],
    context: null,
    answeredAtMs: null,
    answer: null,
    deliveredToAgent: false,
    ...overrides,
  });

  it("rejects a bad credential and a read-only one, like every other route", () =>
    withRoutes({
      auth: authFails(new EnvironmentAuth.ServerAuthInvalidCredentialError({})),
      body: () =>
        Effect.gen(function* () {
          const response = yield* postJson(ANSWER_PATH, {
            threadId: THREAD_ID,
            blockerId: "blocker-1",
            answer: "yes",
          });
          assert.strictEqual(response.status, 401);
        }),
    }));

  it("refuses a read-scope credential — answering mutates scheduling", () =>
    withRoutes({
      auth: authOk([AuthOrchestrationReadScope]),
      body: () =>
        Effect.gen(function* () {
          const response = yield* postJson(ANSWER_PATH, {
            threadId: THREAD_ID,
            blockerId: "blocker-1",
            answer: "yes",
          });
          assert.strictEqual(response.status, 403);
        }),
    }));

  // 81 — the answer is recorded and stays UNDELIVERED: the thread is idle, so nothing has told
  // the agent yet. `deliveredToAgent` is what stops the next check-in either losing it or
  // restating it twice.
  it("records the answer and leaves it undelivered", () =>
    withRoutes({
      body: ({ store }) =>
        Effect.gen(function* () {
          yield* postJson(PATH, armBody());
          yield* store.addBlocker(THREAD_ID, blocker());

          const response = yield* postJson(ANSWER_PATH, {
            threadId: THREAD_ID,
            blockerId: "blocker-1",
            answer: "migrate in place",
          });
          assert.strictEqual(response.status, 200);
          assert.deepStrictEqual(yield* jsonBody(response), { ok: true });

          const record = yield* store.getThread(THREAD_ID);
          const stored = record.blockers[0];
          assert.strictEqual(stored?.answer, "migrate in place");
          assert.notStrictEqual(stored?.answeredAtMs, null);
          assert.strictEqual(stored?.deliveredToAgent, false);

          // And it drops out of the console's actionable list.
          const view = yield* decodeLoopView(
            yield* jsonBody(yield* getJson(`${PATH}?threadId=${THREAD_ID}`)),
          );
          assert.deepStrictEqual(view.blockers, []);
        }),
    }));

  it("is idempotent — a second answer keeps the first", () =>
    withRoutes({
      body: ({ store }) =>
        Effect.gen(function* () {
          yield* postJson(PATH, armBody());
          yield* store.addBlocker(THREAD_ID, blocker());
          yield* postJson(ANSWER_PATH, {
            threadId: THREAD_ID,
            blockerId: "blocker-1",
            answer: "first",
          });
          const second = yield* postJson(ANSWER_PATH, {
            threadId: THREAD_ID,
            blockerId: "blocker-1",
            answer: "second",
          });

          assert.strictEqual(second.status, 200);
          const record = yield* store.getThread(THREAD_ID);
          assert.strictEqual(record.blockers.length, 1, "not a second append");
          assert.strictEqual(record.blockers[0]?.answer, "first");
        }),
    }));

  // 83 — an id nobody raised. A silent 200 would show the console an answer that was never stored.
  it("404s an unknown blocker id, and an unknown thread", () =>
    withRoutes({
      body: ({ store }) =>
        Effect.gen(function* () {
          yield* postJson(PATH, armBody());
          yield* store.addBlocker(THREAD_ID, blocker());

          assert.strictEqual(
            (yield* postJson(ANSWER_PATH, {
              threadId: THREAD_ID,
              blockerId: "never-raised",
              answer: "yes",
            })).status,
            404,
          );
          assert.strictEqual(
            (yield* postJson(ANSWER_PATH, {
              threadId: "never-seen",
              blockerId: "blocker-1",
              answer: "yes",
            })).status,
            404,
          );
        }),
    }));

  it("400s a malformed body and mutates nothing", () =>
    withRoutes({
      body: ({ store }) =>
        Effect.gen(function* () {
          yield* postJson(PATH, armBody());
          yield* store.addBlocker(THREAD_ID, blocker());

          const malformed = [
            ["no fields", {}],
            ["no blockerId", { threadId: THREAD_ID, answer: "yes" }],
            ["no answer", { threadId: THREAD_ID, blockerId: "blocker-1" }],
            ["empty blockerId", { threadId: THREAD_ID, blockerId: "  ", answer: "yes" }],
            ["empty threadId", { threadId: "", blockerId: "blocker-1", answer: "yes" }],
            ["a non-string answer", { threadId: THREAD_ID, blockerId: "blocker-1", answer: 3 }],
          ] as const;
          for (const [label, body] of malformed) {
            const response = yield* postJson(ANSWER_PATH, body);
            assert.strictEqual(response.status, 400, label);
            assert.strictEqual((yield* jsonBody(response)).error, "invalid_body", label);
          }
          assert.strictEqual((yield* store.getThread(THREAD_ID)).blockers[0]?.answer, null);
        }),
    }));

  // A caller-controlled threadId reaches `Object.hasOwn` in the store on this route too.
  it("handles a prototype-chain threadId as an ordinary unknown thread", () =>
    withRoutes({
      threads: [],
      body: () =>
        Effect.gen(function* () {
          for (const hostile of ["constructor", "__proto__", "toString"]) {
            const response = yield* postJson(ANSWER_PATH, {
              threadId: hostile,
              blockerId: "blocker-1",
              answer: "yes",
            });
            assert.strictEqual(response.status, 404, `answer threadId=${hostile} must not 500`);
          }
        }),
    }));
});
