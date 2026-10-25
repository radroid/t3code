import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";

/**
 * Restarting into a freshly installed build, deliberately without `DesktopLifecycle.relaunch`. Its
 * shutdown wait is unbounded (a wedged backend leaves the app on "Restarting…" forever), and it
 * re-execs `process.execPath`, which under App Translocation would come back on the old build.
 * The exec path must come from the install target, not the running process.
 */

/**
 * How long to let a graceful shutdown run before forcing the exit.
 *
 * Long enough for a healthy teardown — backends stop in well under a second normally — and short
 * enough that a hung one costs the user ten seconds rather than their whole session. The relaunch
 * is armed before the timer starts, so a forced exit still comes back up.
 */
export const SHUTDOWN_GRACE = Duration.seconds(10);

export type RestartOutcome = "graceful" | "forced-after-timeout";

/**
 * Quit and come back on the new build: request shutdown and wait (bounded), then arm the relaunch
 * immediately before exiting, then exit regardless. `app.relaunch()` arms the *next* quit, so
 * arming it before a wait that might fail leaves a Cmd-Q that silently resurrects the app.
 */
export const restartIntoInstalledBuild = Effect.fn("coil.updateDelivery.restart")(function* (args: {
  readonly execPath: string;
  readonly argv: readonly string[];
}) {
  const electronApp = yield* ElectronApp.ElectronApp;
  const shutdown = yield* DesktopShutdown.DesktopShutdown;

  yield* shutdown.request;

  // `Effect.timeout` fails on expiry; the failure is the signal to stop waiting, not an error to
  // report. Either way we exit — the only difference is whether backends got to close cleanly.
  const outcome: RestartOutcome = yield* shutdown.awaitComplete.pipe(
    Effect.timeout(SHUTDOWN_GRACE),
    Effect.as<RestartOutcome>("graceful"),
    Effect.orElseSucceed((): RestartOutcome => "forced-after-timeout"),
  );

  if (outcome === "forced-after-timeout") {
    yield* Effect.logWarning(
      "coil: shutdown did not finish within the grace period; forcing exit so the relaunch still happens",
    );
  }

  yield* electronApp.relaunch({ execPath: args.execPath, args: [...args.argv] });
  yield* electronApp.exit(0);

  return outcome;
});

/**
 * Quit and stay quit — the Windows path.
 *
 * Deliberately does NOT arm `app.relaunch()`. On Windows the NSIS installer starts the app again
 * itself (`--force-run`), so arming a relaunch here would race two instances: ours coming back on
 * the old binary while the installer is still replacing it, and the installer's on the new one.
 */
export const quitForInstaller = Effect.fn("coil.updateDelivery.quitForInstaller")(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const shutdown = yield* DesktopShutdown.DesktopShutdown;

  yield* shutdown.request;
  const outcome: RestartOutcome = yield* shutdown.awaitComplete.pipe(
    Effect.timeout(SHUTDOWN_GRACE),
    Effect.as<RestartOutcome>("graceful"),
    Effect.orElseSucceed((): RestartOutcome => "forced-after-timeout"),
  );
  if (outcome === "forced-after-timeout") {
    yield* Effect.logWarning(
      "coil: shutdown did not finish within the grace period; exiting so the installer can proceed",
    );
  }

  yield* electronApp.exit(0);
  return outcome;
});

/**
 * The executable to re-exec, derived from the bundle we just installed into.
 *
 * Never `process.execPath` — see the translocation note above.
 */
export function executablePathForBundle(appBundlePath: string, appName: string): string {
  const binaryName = appName.endsWith(".app") ? appName.slice(0, -".app".length) : appName;
  return `${appBundlePath}/Contents/MacOS/${binaryName}`;
}
