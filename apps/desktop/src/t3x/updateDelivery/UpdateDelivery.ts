/**
 * The fork's update-delivery service: relay in, staged bundle out, one restart on the click.
 *
 * The three-tier ladder the design specifies lives here, and the ordering of the tiers is the
 * point. Push tells you within seconds; the watchdog notices a connection that is open but dead;
 * the floor poll is the tier that still works when both of the others have quietly stopped
 * working. Every tier ends in the same place — read `/latest`, decide, stage — so there is no path
 * that can drift into believing something the others do not.
 */

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { T3xUpdateState, T3xUpdateStatus } from "@t3tools/contracts";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { T3X_UPDATE_STATE_CHANNEL } from "../../ipc/channels.ts";
import {
  FLOOR_POLL_INTERVAL_MS,
  reconnectDelayMs,
  type ReconciliationTrigger,
} from "./connectionHealth.ts";
import { parseBuildNumber, readEmbeddedCommitHash, relayEndpoints, resolveRelayUrl } from "./config.ts";
import { decideUpdateAction, describeSkipReason, type InstalledBuild } from "./decision.ts";
import { macSwapCommands, windowsInstallCommand } from "./installCommands.ts";
import type { UpdateManifest } from "./manifest.ts";
import { fetchLatestManifest, streamRelayEvents } from "./relayClient.ts";
import { executablePathForBundle, quitForInstaller, restartIntoInstalledBuild } from "./restart.ts";
import { shouldAbandonStaging } from "./staging.ts";
import { stageUpdate, type StagedBuild } from "./stager.ts";

export class T3xUpdateDelivery extends Context.Service<
  T3xUpdateDelivery,
  {
    readonly state: Effect.Effect<T3xUpdateState>;
    readonly restartNow: Effect.Effect<void>;
    readonly dismiss: (shortSha: string) => Effect.Effect<void>;
    /** Starts the subscriber and the floor poll. Idempotent; a no-op when delivery is disabled. */
    readonly start: Effect.Effect<void>;
  }
>()("@t3tools/desktop/t3x/updateDelivery/UpdateDelivery/T3xUpdateDelivery") {}

interface Internal {
  readonly status: T3xUpdateStatus;
  readonly staged: StagedBuild | undefined;
  readonly inFlightShortSha: string | undefined;
  readonly hasUpdatedBefore: boolean;
  readonly dismissed: string | undefined;
  /** The highest build number this app has staged or is running. The ordering floor. */
  readonly buildNumberFloor: number | undefined;
}

const externalState = (internal: Internal): T3xUpdateState => ({
  // Dismissal is applied here rather than in the renderer so that a second window opened after a
  // dismissal does not resurrect the toast the user just closed.
  status:
    internal.status.kind === "ready" && internal.dismissed === internal.status.shortSha
      ? { kind: "idle" }
      : internal.status,
  hasUpdatedBefore: internal.hasUpdatedBefore,
});

/**
 * Everything the service needs after construction.
 *
 * Captured once and baked into the returned effects, so `T3xUpdateDelivery` presents a
 * requirement-free interface. Without this the renderer-facing IPC methods would each have to
 * carry `HttpClient | ChildProcessSpawner | ElectronApp | …` in their context, and every caller
 * would have to know how this feature installs software.
 */
type DeliveryServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | DesktopEnvironment.DesktopEnvironment
  | DesktopShutdown.DesktopShutdown
  | ElectronApp.ElectronApp
  | ElectronWindow.ElectronWindow
  | FileSystem.FileSystem
  | HttpClient.HttpClient;

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const services = yield* Effect.context<DeliveryServices>();

  const installedCommitHash = yield* fileSystem
    .readFileString(environment.path.join(environment.appRoot, "package.json"))
    .pipe(
      Effect.map(readEmbeddedCommitHash),
      Effect.orElseSucceed(() => undefined),
    );

  const internal = yield* Ref.make<Internal>({
    status: { kind: "idle" },
    staged: undefined,
    inFlightShortSha: undefined,
    hasUpdatedBefore: false,
    dismissed: undefined,
    buildNumberFloor: parseBuildNumber(environment.appVersion),
  });
  const started = yield* Ref.make(false);

  const publish = Effect.gen(function* () {
    const snapshot = yield* Ref.get(internal);
    yield* electronWindow.sendAll(T3X_UPDATE_STATE_CHANNEL, externalState(snapshot));
  });

  const setStatus = (status: T3xUpdateStatus) =>
    Ref.update(internal, (current) => ({ ...current, status })).pipe(Effect.andThen(publish));

  const installedBuild = Effect.gen(function* () {
    const snapshot = yield* Ref.get(internal);
    return {
      commitHash: installedCommitHash,
      buildNumber: snapshot.buildNumberFloor,
      platform: environment.platform,
      arch: environment.processArch,
      isPackaged: environment.isPackaged,
    } satisfies InstalledBuild;
  });

  /**
   * Everything funnels through here, from every tier.
   *
   * Single-flight by `inFlightShortSha`: two tiers announcing the same build within a second of
   * each other is the normal case, not an edge case — the push arrives and the reconcile poll that
   * follows a reconnect finds the same manifest. Downloading it twice would be 940 MB.
   */
  const considerManifest = Effect.fn("t3x.updateDelivery.consider")(function* (
    manifest: UpdateManifest,
    trigger: ReconciliationTrigger,
  ) {
    const snapshot = yield* Ref.get(internal);

    if (
      snapshot.inFlightShortSha !== undefined &&
      !shouldAbandonStaging({
        inFlightShortSha: snapshot.inFlightShortSha,
        announcedShortSha: manifest.shortSha,
      })
    ) {
      return;
    }

    const decision = decideUpdateAction(manifest, yield* installedBuild);
    if (decision.kind === "skip") {
      // Logged at debug volume on purpose: "already running this build" fires on every reconnect
      // and every floor poll, which is the system working.
      yield* Effect.logDebug(
        `t3x update (${trigger}) skipped ${manifest.shortSha}: ${describeSkipReason(decision.reason)}`,
      );
      return;
    }

    yield* Ref.update(internal, (current) => ({
      ...current,
      inFlightShortSha: manifest.shortSha,
    }));
    yield* setStatus({ kind: "staging", shortSha: manifest.shortSha });
    yield* Effect.logInfo(`t3x update (${trigger}): staging ${manifest.shortSha}`);

    const staged = yield* stageUpdate({
      manifest,
      asset: decision.asset,
      execPath: process.execPath,
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(error.message).pipe(
          Effect.andThen(
            setStatus({
              kind: "failed",
              message: `Could not prepare build ${manifest.shortSha}. ${error.message}`,
            }),
          ),
          Effect.as(undefined),
        ),
      ),
    );

    yield* Ref.update(internal, (current) => ({ ...current, inFlightShortSha: undefined }));
    if (staged === undefined) return;

    yield* Ref.update(internal, (current) => ({
      ...current,
      staged,
      // Raise the floor as soon as the build is staged, not when it is installed. Until the user
      // clicks, this app should ignore anything older than what is already sitting on its disk.
      buildNumberFloor: manifest.buildNumber,
    }));
    yield* setStatus({ kind: "ready", shortSha: staged.shortSha, version: staged.version });
    yield* Effect.logInfo(`t3x update: ${staged.shortSha} is staged and ready`);
  });

  /** Every trigger re-reads `/latest` rather than trusting whatever the stream last said. */
  const reconcile = Effect.fn("t3x.updateDelivery.reconcile")(function* (
    latestUrl: string,
    trigger: ReconciliationTrigger,
  ) {
    const manifest = yield* fetchLatestManifest(latestUrl).pipe(
      Effect.catch((error) =>
        Effect.logDebug(`t3x update reconcile (${trigger}) failed: ${error.message}`).pipe(
          Effect.as(undefined),
        ),
      ),
    );
    if (manifest !== undefined) yield* considerManifest(manifest, trigger);
  });

  const restartNow = Effect.gen(function* () {
    const snapshot = yield* Ref.get(internal);
    if (snapshot.status.kind !== "ready" || snapshot.staged === undefined) {
      // Not an error. Two windows mean two toasts; the second click is a duplicate, not a fault.
      yield* Effect.logDebug("t3x update: restart requested with nothing ready; ignoring");
      return;
    }
    const staged = snapshot.staged;
    yield* setStatus({ kind: "restarting" });

    if (environment.platform === "darwin") {
      // The swap is two commands and no copying — everything expensive happened during staging.
      const swap = macSwapCommands({
        targetAppPath: staged.targetPath,
        stagedAppPath: staged.artifactPath,
      });
      const applied = yield* runSwap(swap).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          setStatus({
            kind: "failed",
            message: `The update could not be applied. ${error.message}`,
          }).pipe(Effect.as(false)),
        ),
      );
      if (!applied) return;

      yield* Ref.update(internal, (current) => ({ ...current, hasUpdatedBefore: true }));
      yield* restartIntoInstalledBuild({
        execPath: executablePathForBundle(staged.targetPath, staged.appName),
        argv: process.argv.slice(1),
      });
      return;
    }

    // Windows is restarted BY the installer: it needs the app's own files, so a silent install
    // against a running app is the documented way to hang forever with no UI.
    const command = windowsInstallCommand(staged.artifactPath);
    const started = yield* spawnDetached(command.bin, command.args).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        setStatus({
          kind: "failed",
          message: `The installer could not be started. ${error.message}`,
        }).pipe(Effect.as(false)),
      ),
    );
    if (!started) return;

    yield* Ref.update(internal, (current) => ({ ...current, hasUpdatedBefore: true }));
    yield* quitForInstaller();
  });

  const start = Effect.gen(function* () {
    if (yield* Ref.getAndSet(started, true)) return;

    const relayUrl = resolveRelayUrl(process.env);
    if (relayUrl === undefined) {
      yield* Effect.logInfo("t3x update delivery is disabled for this run");
      return;
    }
    if (!environment.isPackaged) {
      // Same reason `decideUpdateAction` refuses: a dev build has no identity to compare and no
      // bundle to swap. Not starting at all is better than starting and skipping forever.
      yield* Effect.logDebug("t3x update delivery: not a packaged build, staying idle");
      return;
    }

    const endpoints = relayEndpoints(relayUrl);
    yield* reconcile(endpoints.latest, "startup");

    // Tier 1 and 2: the stream, and the watchdog inside it. A stream that ends for ANY reason —
    // clean 15-minute cap, dead socket, stall — reconnects and then reconciles, so the reconnect
    // path can never be the one that misses a release.
    const subscriber = Effect.gen(function* () {
      let attempt = 0;
      while (true) {
        const outcome = yield* streamRelayEvents({
          eventsUrl: endpoints.events,
          onManifest: (manifest) =>
            considerManifest(manifest, "push").pipe(Effect.provideContext(services)),
        }).pipe(Effect.as("ended" as const), Effect.catch(Effect.succeed));

        const reason = outcome === "ended" ? "stream-closed" : outcome.reason;
        yield* Effect.logDebug(`t3x update stream ended (${reason}); reconnecting`);
        yield* Effect.sleep(Duration.millis(reconnectDelayMs(attempt, Math.random)));
        attempt = Math.min(attempt + 1, 16);
        yield* reconcile(
          endpoints.latest,
          reason === "stream-stalled" ? "watchdog-fired" : "stream-closed",
        );
        // Only a stream that carried bytes resets the backoff. Resetting on every attempt would
        // turn a relay that accepts connections and immediately closes them into a hot loop.
        if (reason === "stream-closed") attempt = 0;
      }
    });

    // Tier 3: the floor. Runs regardless of what the stream believes about itself, because the
    // failure this catches is a subscriber that thinks it is healthy and is not.
    const floorPoll = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(Duration.millis(FLOOR_POLL_INTERVAL_MS));
        yield* reconcile(endpoints.latest, "floor-poll");
      }
    });

    yield* Effect.forkDetach(subscriber.pipe(Effect.orDie));
    yield* Effect.forkDetach(floorPoll.pipe(Effect.orDie));
    yield* Effect.logInfo(`t3x update delivery listening on ${endpoints.events}`);
  });

  // Started from the layer rather than from `DesktopApp.program`, which is upstream-owned and not
  // in the seam ledger. There is no ordering requirement against window creation: this makes HTTP
  // calls and broadcasts to whatever windows exist at the time, and `sendAll` to none is a no-op.
  yield* Effect.forkDetach(start);

  return {
    state: Ref.get(internal).pipe(Effect.map(externalState)),
    restartNow: restartNow.pipe(Effect.provideContext(services)),
    dismiss: (shortSha: string) =>
      Ref.update(internal, (current) => ({ ...current, dismissed: shortSha })).pipe(
        Effect.andThen(publish),
        Effect.provideContext(services),
      ),
    start: start.pipe(Effect.provideContext(services)),
  } as const;
});

export const layer = Layer.effect(T3xUpdateDelivery, make);

// --- process helpers -------------------------------------------------------------------------
// Kept at the bottom and deliberately small: the interesting logic above should not be interleaved
// with spawn plumbing.

export class T3xInstallCommandError extends Schema.TaggedErrorClass<T3xInstallCommandError>()(
  "T3xInstallCommandError",
  { bin: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `${this.bin} failed: ${this.detail}`;
  }
}

const runSwap = Effect.fn("t3x.updateDelivery.swap")(function* (
  commands: readonly { readonly bin: string; readonly args: readonly string[] }[],
) {
  for (const command of commands) {
    yield* spawnAwaited(command.bin, command.args);
  }
});

const spawnAwaited = Effect.fn("t3x.updateDelivery.spawnAwaited")(function* (
  bin: string,
  args: readonly string[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(bin, [...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
    )
    .pipe(
      Effect.mapError((cause) => new T3xInstallCommandError({ bin, detail: String(cause) })),
    );
  const exitCode = yield* handle.exitCode.pipe(
    Effect.mapError((cause) => new T3xInstallCommandError({ bin, detail: String(cause) })),
  );
  if ((exitCode as unknown as number) !== 0) {
    return yield* new T3xInstallCommandError({ bin, detail: `exited ${String(exitCode)}` });
  }
}, Effect.scoped);

/**
 * Spawned into a scope that is never closed, on purpose.
 *
 * The NSIS installer has to outlive this process: it needs the app's own files, so the app quits
 * and the installer relaunches it. `spawner.spawn` normally ties the child's life to a scope, and
 * closing that scope would tear down the very installer we just started. So the scope is made by
 * hand and left open — this process is about to call `app.exit`, at which point a `detached` child
 * is reparented by the OS and survives. Awaiting the child instead would deadlock: it is waiting
 * for us to quit.
 */
const spawnDetached = Effect.fn("t3x.updateDelivery.spawnDetached")(function* (
  bin: string,
  args: readonly string[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.make();
  yield* spawner
    .spawn(
      ChildProcess.make(bin, [...args], {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError((cause) => new T3xInstallCommandError({ bin, detail: String(cause) })),
    );
});
