import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_MODEL,
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { HttpServer } from "effect/unstable/http";

import * as ServerConfig from "./config.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as Keybindings from "./keybindings.ts";
import { OrchestrationCommandInvariantError } from "./orchestration/Errors.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as OrchestrationReactor from "./orchestration/Services/OrchestrationReactor.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as ProviderSessionReaper from "./provider/Services/ProviderSessionReaper.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.succeed({
          isRepo: true,
          isDefaultBranch: cwd !== "/feature",
          hasUpstream: true,
          hasWorkingTreeChanges: cwd === "/dirty",
          aheadCount: cwd === "/ahead" ? 1 : 0,
          behindCount: cwd === "/current" ? 0 : 1,
        } as never),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string) =>
      ({ id: ProjectId.make(workspaceRoot), workspaceRoot }) as never;
    const overrides = (entries: Record<string, boolean>) => ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        Object.entries(entries).map(([root, defaultAutoPull]) => [
          ProjectId.make(root),
          { defaultAutoPull },
        ]),
      ),
    });

    yield* ServerRuntimeStartup.autoPullProjects(
      [
        project("/clean"),
        project("/current"),
        project("/dirty"),
        project("/ahead"),
        project("/feature"),
        project("/disabled"),
      ],
      overrides({
        "/clean": true,
        "/current": true,
        "/dirty": true,
        "/ahead": true,
        "/feature": true,
        "/disabled": false,
      }),
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);

    pulled.length = 0;
    yield* ServerRuntimeStartup.autoPullProjects(
      [project("/inherited"), project("/opted-out"), project("/dirty")],
      { ...overrides({ "/opted-out": false }), defaultAutoPull: true },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));
    assert.deepStrictEqual(pulled, ["/inherited"]);
  }),
);

it.effect("enqueueCommand waits for readiness and then drains queued work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executionCount = yield* Ref.make(0);
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Ref.updateAndGet(executionCount, (count) => count + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(executionCount), 0);

      yield* commandGate.signalCommandReady;

      const result = yield* Fiber.join(queuedCommandFiber);
      assert.equal(result, 1);
      assert.equal(yield* Ref.get(executionCount), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("resolveAutoBootstrapWelcomeTargets returns existing project and thread ids", () => {
  const bootstrapProjectId = ProjectId.make("project-startup-bootstrap");
  const bootstrapThreadId = ThreadId.make("thread-startup-bootstrap");

  return Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provide(ServerSettings.layerTest()),
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getUserInputActivity: () => Effect.die("unused"),
        listActivitiesByKind: () => Effect.succeed([]),
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getDeletedWorktreeThreads: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getEventReplayStats: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () =>
          Effect.succeed(
            Option.some({
              id: bootstrapProjectId,
              title: "Startup Project",
              workspaceRoot: "/tmp/startup-project",
              defaultModelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: DEFAULT_MODEL,
              },
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
            }),
          ),
        getProjectShells: () => Effect.die("unused"),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.some(bootstrapThreadId)),
        getImportedAgentSessionSources: () => Effect.die("unused"),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadRuntimeContext: () => Effect.die("unused"),
        getTurnStartMessage: () => Effect.die("unused"),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused thread replay stats"),
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    assert.deepStrictEqual(targets, {
      bootstrapProjectId,
      bootstrapThreadId,
      bootstrapProjectCreated: false,
      bootstrapThreadCreated: false,
    });
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  });
});

it.effect.each([
  {
    existing: false,
    machineModel: null,
    projectModel: null,
    machineMode: "full-access",
    projectMode: null,
  },
  {
    existing: false,
    machineModel: "claude-sonnet-4-6",
    projectModel: null,
    machineMode: "approval-required",
    projectMode: null,
  },
  {
    existing: true,
    machineModel: "claude-sonnet-4-6",
    projectModel: null,
    machineMode: "auto",
    projectMode: null,
  },
  {
    existing: true,
    machineModel: "claude-sonnet-4-6",
    projectModel: "gpt-5.4",
    machineMode: "full-access",
    projectMode: "auto-accept-edits",
  },
] as const)("auto-bootstrap model and permissions precedence: %j", (options) =>
  Effect.gen(function* () {
    const { existing, machineModel, projectModel, machineMode, projectMode } = options;
    const machineSelection = machineModel
      ? { instanceId: ProviderInstanceId.make("claude-code"), model: machineModel }
      : null;
    const projectSelection = projectModel
      ? { instanceId: ProviderInstanceId.make("codex"), model: projectModel }
      : null;
    const dispatchCalls = yield* Ref.make<
      ReadonlyArray<{
        readonly type: string;
        readonly defaultModelSelection?: unknown;
        readonly modelSelection?: unknown;
        readonly runtimeMode?: unknown;
      }>
    >([]);
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provide(
        ServerSettings.layerTest({
          defaultModelSelection: machineSelection,
          defaultRuntimeMode: machineMode,
          projectSettingsOverrides:
            existing && projectSelection
              ? {
                  [ProjectId.make("existing-project")]: {
                    defaultModelSelection: projectSelection,
                    ...(projectMode ? { defaultRuntimeMode: projectMode } : {}),
                  },
                }
              : {},
        }),
      ),
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getUserInputActivity: () => Effect.die("unused"),
        listActivitiesByKind: () => Effect.succeed([]),
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getDeletedWorktreeThreads: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getEventReplayStats: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () =>
          Effect.succeed(
            existing
              ? Option.some({
                  id: ProjectId.make("existing-project"),
                  title: "Startup Project",
                  workspaceRoot: "/tmp/startup-project",
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                  deletedAt: null,
                })
              : Option.none(),
          ),
        getProjectShells: () => Effect.die("unused"),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getImportedAgentSessionSources: () => Effect.die("unused"),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadRuntimeContext: () => Effect.die("unused"),
        getTurnStartMessage: () => Effect.die("unused"),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused thread replay stats"),
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    assert.equal(typeof targets.bootstrapProjectId, "string");
    assert.equal(typeof targets.bootstrapThreadId, "string");
    assert.equal(targets.bootstrapProjectCreated, !existing);
    assert.equal(targets.bootstrapThreadCreated, true);
    const commands = yield* Ref.get(dispatchCalls);
    assert.deepStrictEqual(
      commands.map((command) => command.type),
      existing ? ["thread.create"] : ["project.create", "thread.create"],
    );
    if (!existing) assert.equal("defaultModelSelection" in commands[0]!, false);
    assert.equal(commands.at(-1)?.runtimeMode, projectMode ?? machineMode);
    assert.deepStrictEqual(
      commands.at(-1)?.modelSelection,
      projectSelection ??
        machineSelection ?? {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        },
    );
  }),
);

it.effect(
  "resolveAutoBootstrapWelcomeTargets preserves a project created before thread failure",
  () =>
    Effect.gen(function* () {
      const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
      const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
        Effect.provide(ServerSettings.layerTest()),
        Effect.provideService(ServerConfig.ServerConfig, {
          cwd: "/tmp/startup-project",
          autoBootstrapProjectFromCwd: true,
        } as never),
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getUserInputActivity: () => Effect.die("unused"),
          listActivitiesByKind: () => Effect.succeed([]),
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getDeletedWorktreeThreads: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
          getCounts: () => Effect.die("unused"),
          getEventReplayStats: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShells: () => Effect.die("unused"),
          getProjectShellById: () => Effect.die("unused"),
          getFirstActiveThreadIdByProjectId: () => Effect.die("thread lookup failed"),
          getImportedAgentSessionSources: () => Effect.die("unused"),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getFullThreadDiffContext: () => Effect.succeed(Option.none()),
          getThreadRuntimeContext: () => Effect.die("unused"),
          getTurnStartMessage: () => Effect.die("unused"),
          getThreadShellById: () => Effect.die("unused"),
          getThreadDetailById: () => Effect.die("unused"),
          getThreadDetailSnapshot: () => Effect.die("unused"),
          searchThreads: () => Effect.succeed({ matches: [] }),
        }),
        Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () => Effect.die("unused thread replay stats"),
          dispatch: (command) =>
            Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
              Effect.as({ sequence: 1 }),
            ),
          streamDomainEvents: Stream.empty,
          subscribeDomainEvents: Effect.succeed(Stream.empty),
          latestSequence: Effect.succeed(0),
        } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
        Effect.provide(NodeServices.layer),
      );

      assert.equal(typeof targets.bootstrapProjectId, "string");
      assert.equal(targets.bootstrapProjectCreated, true);
      assert.equal(targets.bootstrapThreadId, undefined);
      assert.equal(targets.bootstrapThreadCreated, undefined);
      assert.deepStrictEqual(yield* Ref.get(dispatchCalls), ["project.create"]);
    }),
);

it.effect("resolveAutoBootstrapWelcomeTargets preserves typed UUID generation failures", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const uuidError = PlatformError.systemError({
      _tag: "Unknown",
      module: "Crypto",
      method: "randomUUIDv4",
      description: "UUID generation unavailable",
    });
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);

    const error = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provide(ServerSettings.layerTest()),
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getUserInputActivity: () => Effect.die("unused"),
        listActivitiesByKind: () => Effect.succeed([]),
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getDeletedWorktreeThreads: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getEventReplayStats: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShells: () => Effect.die("unused"),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getImportedAgentSessionSources: () => Effect.die("unused"),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadRuntimeContext: () => Effect.die("unused"),
        getTurnStartMessage: () => Effect.die("unused"),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused thread replay stats"),
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provideService(Crypto.Crypto, {
        ...crypto,
        randomUUIDv4: Effect.fail(uuidError),
      }),
      Effect.flip,
    );

    assert.strictEqual(error, uuidError);
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

// A read model with one thread frozen mid-turn the way an ungraceful crash leaves it:
// running latest turn, live session, non-null activeTurnId.
const crashedReadModel = (): OrchestrationReadModel =>
  ({
    snapshotSequence: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-crashed"),
        latestTurn: { turnId: TurnId.make("turn-1"), state: "running" },
        session: {
          threadId: ThreadId.make("thread-crashed"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ],
  }) as unknown as OrchestrationReadModel;

/**
 * Drive the real `ServerRuntimeStartup.make` orchestration with lightweight service
 * doubles, seeding one crashed thread. The engine `dispatch` double appends "reconcile"
 * and the orchestration reactor `start` double appends "reactor", so the returned order
 * proves the reconcile phase runs before reactors start and (because command readiness is
 * only signalled after the whole startup sequence completes) before command readiness.
 */
const driveStartupMake = (dispatchFails: boolean) =>
  Effect.gen(function* () {
    const order = yield* Ref.make<ReadonlyArray<string>>([]);

    const engineDouble = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Ref.update(order, (entries) => [...entries, "reconcile"]).pipe(
          Effect.flatMap(() =>
            dispatchFails
              ? Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "simulated crash-recovery dispatch failure",
                  }),
                )
              : Effect.succeed({ sequence: 1 }),
          ),
        ),
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    };

    yield* Effect.scoped(
      Effect.gen(function* () {
        const startup = yield* ServerRuntimeStartup.make().pipe(
          Effect.provideService(ServerConfig.ServerConfig, {
            cwd: "/tmp/startup-crash-recovery",
            mode: "web",
            port: 3773,
            host: "127.0.0.1",
            autoBootstrapProjectFromCwd: false,
          } as never),
          Effect.provideService(Keybindings.Keybindings, { start: Effect.void } as never),
          Effect.provideService(ServerSettings.ServerSettingsService, {
            start: Effect.void,
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          } as never),
          Effect.provideService(OrchestrationReactor.OrchestrationReactor, {
            start: () =>
              Ref.update(order, (entries) => [...entries, "reactor"]).pipe(Effect.asVoid),
          } as never),
          Effect.provideService(ProviderSessionReaper.ProviderSessionReaper, {
            start: () => Effect.void,
          } as never),
          Effect.provideService(ServerLifecycleEvents.ServerLifecycleEvents, {
            publish: () => Effect.void,
          } as never),
          Effect.provideService(ServerEnvironment.ServerEnvironment, {
            getDescriptor: Effect.succeed({ environmentId: "env-test" }),
          } as never),
          Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
            getSnapshot: () => Effect.succeed(crashedReadModel()),
            // Upstream's `projects.auto-pull` phase reads the shell snapshot after reactors
            // start; no projects means it never touches git.
            getShellSnapshot: () => Effect.succeed({ ...crashedReadModel(), projects: [] }),
          } as never),
          Effect.provideService(GitVcsDriver.GitVcsDriver, {} as never),
          Effect.provideService(
            OrchestrationEngine.OrchestrationEngineService,
            engineDouble as never,
          ),
          // Referenced by the startup tail (heartbeat / browser / headless access). Upstream
          // moved `signalCommandReady` to *after* the `http.wait` gate, so this test now has to
          // mark the HTTP listener ready to reach readiness at all — and therefore does run the
          // tail. These doubles keep it inert.
          Effect.provideService(AnalyticsService.AnalyticsService, {
            record: () => Effect.void,
            flush: Effect.void,
          } as never),
          Effect.provideService(EnvironmentAuth.EnvironmentAuth, {
            issueStartupPairingUrl: () => Effect.succeed("http://localhost"),
          } as never),
          Effect.provideService(ExternalLauncher.ExternalLauncher, {
            launchBrowser: () => Effect.void,
          } as never),
          Effect.provideService(HttpServer.HttpServer, {} as never),
          // Upstream's "prepared boundary": startup asks the launcher to prepare a trial
          // update after `http.wait` and before command readiness. No update in this test.
          Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, {
            prepareTrial: Effect.void,
          } as never),
          // Upstream #7719 added an orphaned-provider-session pass to startup. This test is
          // about crash-recovery ordering, not orphan cleanup, so the provider reports the
          // seeded thread as live and that pass finds nothing to reconcile — otherwise its
          // dispatch would append a second "reconcile" to `order`.
          Effect.provideService(ProviderService.ProviderService, {
            listSessions: () => Effect.succeed([{ threadId: ThreadId.make("thread-crashed") }]),
          } as never),
          Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, {
            getBinding: () => Effect.succeed(Option.none()),
            upsert: () => Effect.void,
          } as never),
        );
        // `signalCommandReady` now sits behind the `http.wait` gate, so readiness never
        // resolves unless the listener is marked. Both assertions below concern phases that
        // run well before this gate, so marking it immediately does not weaken them.
        yield* startup.markHttpListening;
        yield* startup.awaitCommandReady;
      }),
    );

    return yield* Ref.get(order);
  }).pipe(Effect.provide(NodeServices.layer));

it.effect("runs crash-recovery reconcile before reactors start and before command readiness", () =>
  Effect.gen(function* () {
    const order = yield* driveStartupMake(false);
    // Reconcile dispatched (settling the crashed thread) strictly before reactors started,
    // and command readiness only resolves after the whole sequence, so reconcile precedes it.
    assert.deepStrictEqual(order, ["reconcile", "reactor"]);
  }),
);

it.effect("swallows a reconcile dispatch failure so startup still signals command readiness", () =>
  Effect.gen(function* () {
    // If the failure were not swallowed, startup would fail and `awaitCommandReady` would
    // reject, failing this test. A resolved readiness with reactors still started proves the
    // per-thread dispatch failure was contained.
    const order = yield* driveStartupMake(true);
    assert.deepStrictEqual(order, ["reconcile", "reactor"]);
  }),
);

it.effect("completeAutoBootstrapWelcome settles failures without bootstrap targets", () =>
  Effect.gen(function* () {
    const completion = yield* ServerRuntimeStartup.completeAutoBootstrapWelcome(
      Effect.fail("bootstrap failed"),
    );

    assert.deepStrictEqual(completion, { bootstrapStatus: "complete" });
  }),
);

it.effect("completeAutoBootstrapWelcome settles unexpected defects", () =>
  Effect.gen(function* () {
    const completion = yield* ServerRuntimeStartup.completeAutoBootstrapWelcome(
      Effect.die("bootstrap defect"),
    );

    assert.deepStrictEqual(completion, { bootstrapStatus: "complete" });
  }),
);

it.effect("completeAutoBootstrapWelcome settles an empty bootstrap result", () =>
  Effect.gen(function* () {
    const completion = yield* ServerRuntimeStartup.completeAutoBootstrapWelcome(Effect.succeed({}));

    assert.deepStrictEqual(completion, { bootstrapStatus: "complete" });
  }),
);
