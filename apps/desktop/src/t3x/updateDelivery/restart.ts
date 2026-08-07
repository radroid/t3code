import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";

/**
 * Restarting into a freshly installed build.
 *
 * This deliberately does **not** call `DesktopLifecycle.relaunch`, even though that exists and does
 * almost this. Two differences make it unusable here, and both are load-bearing:
 *
 * 1. **Its shutdown wait is unbounded.** `requestDesktopShutdownAndWait` awaits a bare `Deferred`
 *    that resolves only once every backend has stopped, and `DesktopBackendManager.closeRun` takes
 *    a no-timeout branch when given no options. A wedged PTY drain, an SSH tunnel, or a `wsl.exe`
 *    backend that never returns means the relaunch never fires — the app sits on "Restarting…"
 *    indefinitely. That is issue #41 reached through a different door: an app that is dark, for an
 *    unbounded time, with no error anywhere.
 *
 * 2. **It re-execs `process.execPath`.** Under macOS App Translocation that points into a
 *    randomised read-only snapshot, so the app would come back on the OLD build while
 *    post-install verification passed against the wrong process. `installTarget.ts` refuses
 *    translocated paths before we ever get here, but the exec path still has to come from the
 *    install target rather than from the running process.
 *
 * Editing `DesktopLifecycle.ts` to add a timeout was the other option. It would have added seam
 * row 36 to a ledger whose own tripwire asks for re-isolation first, on a file the fork does not
 * currently touch — so this restart path lives here instead.
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
 * Quit and come back on the new build.
 *
 * Ordering is the point of this function:
 *
 * 1. Ask for shutdown and wait, bounded.
 * 2. Arm the relaunch — immediately before exiting, never earlier. `app.relaunch()` registers
 *    intent for the *next* quit, so arming it before a wait that might fail would leave the app
 *    alive with a booby-trapped Cmd-Q that silently resurrects it later.
 * 3. Exit, whether or not the shutdown finished.
 */
export const restartIntoInstalledBuild = Effect.fn("t3x.updateDelivery.restart")(function* (args: {
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
    Effect.catch(() => Effect.succeed<RestartOutcome>("forced-after-timeout")),
  );

  if (outcome === "forced-after-timeout") {
    yield* Effect.logWarning(
      "t3x: shutdown did not finish within the grace period; forcing exit so the relaunch still happens",
    );
  }

  yield* electronApp.relaunch({ execPath: args.execPath, args: [...args.argv] });
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
