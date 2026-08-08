/**
 * What the update toast shows, as a pure function of the delivery state.
 *
 * Split from the component in the style of `ProviderUpdateLaunchNotification.logic.ts`, so the
 * state machine can be tested without rendering. The interesting cases here are the ones where
 * showing nothing is correct — a toast that appears while an update is merely downloading trains
 * people to ignore it.
 */

import type { T3xUpdateStatus } from "@t3tools/contracts";

import { isMacPlatform, isWindowsPlatform } from "../../lib/utils.ts";

/**
 * Aliased rather than redeclared. The same union crosses the IPC boundary, and two copies of it
 * would drift the moment one side gained a state — with the renderer silently falling through to
 * "show nothing", which is the failure this whole feature exists to remove.
 */
export type UpdateDeliveryStatus = T3xUpdateStatus;

/**
 * How long an armed auto-restart is allowed to wait for the app to go quiet.
 *
 * There has to be a ceiling. Idleness is derived from `threadIsProgressing` in
 * `apps/server/src/t3x/autoResume/guards.ts`, which reads `session.status` and
 * `latestTurn.state` — and turns get wedged in `running`. "reconcile crash-frozen `running` turns
 * to interrupted on boot" has landed in this repo more than once, and the Loop Watch design (#38)
 * records the same rule from the other direction: never gate on `session.status`, because
 * synthetic turns deadlock it.
 *
 * Without this, an armed restart against one wedged thread waits forever while the user believes
 * the update is handled. That is issue #41's failure mode — a silent nothing — not a new one.
 */
export const AUTO_RESTART_CEILING_MS = 2 * 60 * 60 * 1000;

/** An armed auto-restart, as the main process reports it. */
export interface AutoRestartArmed {
  /** Epoch ms at which the user armed it. */
  readonly armedAt: number;
}

export interface UpdateToastInput {
  readonly status: UpdateDeliveryStatus;
  readonly dismissedShortSha: string | undefined;
  readonly isElectron: boolean;
  /**
   * `navigator.platform`, injected rather than read here so the copy is testable — same reason as
   * `now`. What the click actually does differs enough per platform that one label cannot be
   * honest for all of them.
   */
  readonly platform: string;
  /** True once this app has installed at least one update through this path. */
  readonly hasUpdatedBefore: boolean;
  /** Present while an auto-restart is armed. Owned by main, so it survives a window reload. */
  readonly autoRestart?: AutoRestartArmed | undefined;
  /** Epoch ms. Injected rather than read from the clock, so the ceiling is testable. */
  readonly now?: number | undefined;
}

export type UpdateToastView =
  | { readonly kind: "hidden" }
  | {
      readonly kind: "ready";
      readonly title: string;
      readonly description: string;
      readonly actionLabel: string;
      /** Label for the arm-auto-restart control. */
      readonly autoRestartLabel: string;
      readonly shortSha: string;
      readonly dismissible: true;
      /** Commit subjects for the "What changed" disclosure. Empty when the manifest omitted them. */
      readonly changes: readonly string[];
      /** e.g. "4 min ago". Undefined when the manifest omitted `builtAt`. */
      readonly builtAgo: string | undefined;
      /** Link target for the age. Undefined when the manifest omitted the run url. */
      readonly runUrl: string | undefined;
      /**
       * True when an armed auto-restart hit its ceiling and fell back to prompting. The user asked
       * not to be interrupted, so the fallback must say why it is asking again rather than
       * silently re-appearing as a fresh prompt.
       */
      readonly autoRestartTimedOut: boolean;
    }
  | {
      readonly kind: "armed";
      readonly title: string;
      readonly description: string;
      /** Escape hatch: arming must never take away the ability to restart now. */
      readonly actionLabel: string;
      readonly cancelLabel: string;
      readonly shortSha: string;
      readonly dismissible: true;
    }
  | { readonly kind: "restarting"; readonly title: string }
  | {
      readonly kind: "failed";
      readonly title: string;
      readonly description: string;
      readonly dismissible: true;
    };

/**
 * macOS authorises privacy permissions against the app's code-signing identity, and
 * electron-builder ad-hoc signs every build — so the identity changes each time and the grants
 * reset. At merge-to-main cadence that is every update, not occasionally.
 *
 * Shown once, on the first update only. Repeating it every time would make it wallpaper, and it
 * is the kind of thing a user needs to understand once and then recognise.
 */
const FIRST_UPDATE_PERMISSION_NOTE =
  " Because these builds are unsigned, macOS will ask for screen-recording and automation permissions again after restarting.";

/**
 * Windows is not offered a "Restart", because it is not one.
 *
 * On macOS the click is a delete and a rename — staging already did everything expensive, so
 * "Restart" is honest. On Windows the click hands off to a silent NSIS installer that unpacks
 * several hundred MB while Defender scans every file of an unsigned build, and the app is GONE for
 * the duration: no window, and a Start-menu shortcut that reports the app does not exist.
 *
 * Presenting those two as the same one-word action is what turns an ordinary wait into "the update
 * deleted my app" — which is exactly how it was read the first time it ran.
 */
const WINDOWS_INSTALL_NOTE =
  "T3 Code will close, install the update, and reopen itself. This usually takes a few minutes, and the window and Start-menu shortcut are unavailable until it finishes.";

function plural(count: number): string {
  return count === 1 ? "change" : "changes";
}

/** Shown when the ceiling fires, so the re-prompt is not mistaken for a fresh one. */
const TIMED_OUT_NOTE =
  " Something has been running for a while, so the automatic restart stood down.";

/**
 * The build's age, in the toast's voice.
 *
 * Coarse on purpose: the exact second a build was produced is never the question. "just now"
 * rather than "0 min ago" because a build that finished seconds ago is the common case — the whole
 * point of this pipeline is that a merge reaches you quickly.
 *
 * A negative age means the builder's clock ran ahead of this machine's. Clamped to "just now"
 * rather than rendering "in 3 minutes", which reads as a bug in the app rather than clock skew.
 */
export function formatBuiltAgo(builtAt: string, now: number): string | undefined {
  const built = Date.parse(builtAt);
  if (Number.isNaN(built)) return undefined;

  const minutes = Math.floor((now - built) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Whether an armed auto-restart has outlived its ceiling. */
export function autoRestartExpired(armed: AutoRestartArmed, now: number): boolean {
  return now - armed.armedAt >= AUTO_RESTART_CEILING_MS;
}

export function selectUpdateToastView(input: UpdateToastInput): UpdateToastView {
  // The whole feature is desktop-only: there is no bundle to swap in a browser tab.
  if (!input.isElectron) return { kind: "hidden" };

  switch (input.status.kind) {
    case "idle":
      return { kind: "hidden" };

    // Staging is silent on purpose. The user asked to be told when an update is READY, and a
    // progress bar for something they cannot act on yet is noise that teaches them to dismiss the
    // toast without reading it.
    case "staging":
      return { kind: "hidden" };

    case "ready": {
      // Dismissal is per-build, not global. Dismissing one update must not suppress the next one
      // — that would silently opt the user out of updates forever from a single click.
      if (input.dismissedShortSha === input.status.shortSha) return { kind: "hidden" };

      const armed = input.autoRestart;
      const expired = armed !== undefined && autoRestartExpired(armed, input.now ?? armed.armedAt);

      // Armed and still within the ceiling: the toast stays up saying so. It deliberately does not
      // hide — an invisible armed restart is indistinguishable from one that never fires.
      if (armed !== undefined && !expired) {
        return {
          kind: "armed",
          title: "Restarting when work finishes",
          description: "T3 Code will restart once nothing is running. You can keep working.",
          actionLabel: "Restart now",
          cancelLabel: "Cancel",
          shortSha: input.status.shortSha,
          dismissible: true,
        };
      }

      const changes = input.status.changes ?? [];
      const now = input.now ?? Date.now();

      return {
        kind: "ready",
        // The count is the headline when we have it. "3 changes ready to run" answers the question
        // a fork maintainer actually has; "Update ready" does not. Falls back cleanly to the
        // generic title when the manifest carried no subjects, rather than saying "0 changes".
        title:
          changes.length > 0
            ? `${changes.length} ${plural(changes.length)} ready to run`
            : "Update ready",
        description:
          (isWindowsPlatform(input.platform)
            ? WINDOWS_INSTALL_NOTE
            : "Restart to update T3 Code.") +
          (expired ? TIMED_OUT_NOTE : "") +
          // Gated on macOS, not merely on "first update". The note names screen-recording and
          // automation prompts, which are a macOS concept — every Windows and Linux user was
          // being told to expect permission dialogs their OS will never show.
          (isMacPlatform(input.platform) && !input.hasUpdatedBefore
            ? FIRST_UPDATE_PERMISSION_NOTE
            : ""),
        actionLabel: isWindowsPlatform(input.platform) ? "Install and reopen" : "Restart",
        autoRestartLabel: isWindowsPlatform(input.platform)
          ? "Install when idle"
          : "Restart when idle",
        shortSha: input.status.shortSha,
        dismissible: true,
        changes,
        builtAgo:
          input.status.builtAt === undefined
            ? undefined
            : formatBuiltAgo(input.status.builtAt, now),
        runUrl: input.status.runUrl,
        autoRestartTimedOut: expired,
      };
    }

    case "restarting":
      return { kind: "restarting", title: "Restarting…" };

    case "failed":
      // Never silent. A failed install that says nothing is the other half of issue #41 — the
      // 103-minute outage was invisible precisely because the failing path had no way to speak.
      return {
        kind: "failed",
        title: "Update failed",
        description:
          input.status.logPath === undefined
            ? input.status.message
            : `${input.status.message} Details: ${input.status.logPath}`,
        dismissible: true,
      };
  }
}

/**
 * Whether a Restart click should be forwarded to the main process.
 *
 * `__root.tsx` renders per window, so two open windows mean two toasts and two possible clicks
 * racing on one bundle. The main process is single-flight regardless — this just avoids sending
 * a request that is guaranteed to be refused.
 *
 * `armed` is included because that view keeps a "Restart now" escape hatch.
 */
export function shouldSendRestart(view: UpdateToastView): boolean {
  return view.kind === "ready" || view.kind === "armed";
}

/** Whether the arm control should be forwarded. Only meaningful from the un-armed ready view. */
export function shouldArmAutoRestart(view: UpdateToastView): boolean {
  return view.kind === "ready";
}

/**
 * The shape this module needs from a thread. Structural on purpose, so the logic stays testable
 * without constructing a full `EnvironmentThreadShell`.
 */
export interface ProgressCandidateThread {
  readonly environmentId: string;
  readonly latestTurn: { readonly state: string } | null;
  readonly archivedAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
}

/**
 * How many threads are still working.
 *
 * Keyed on `latestTurn.state`, deliberately NOT on `session.status`. The server's
 * `threadIsProgressing` checks both, but the Loop Watch design (#38) records that `session.status`
 * deadlocks on synthetic turns — and here a stuck `session.status` would mean an armed restart
 * that never fires. The turn state is the narrower, more honest signal; the ceiling covers the
 * case where even that wedges.
 *
 * Scoped to the primary environment. Restarting the desktop app tears down the server it hosts,
 * so remote-environment threads are not at risk from the restart and must not be able to block it
 * forever.
 *
 * Archived and explicitly-settled threads are excluded: a thread the user has put away should not
 * hold the app hostage because its last turn was never marked finished.
 */
export function countProgressingThreads(
  threads: readonly ProgressCandidateThread[],
  primaryEnvironmentId: string | null,
): number {
  if (primaryEnvironmentId === null) return 0;
  return threads.filter(
    (thread) =>
      thread.environmentId === primaryEnvironmentId &&
      thread.archivedAt === null &&
      thread.settledOverride !== "settled" &&
      thread.latestTurn?.state === "running",
  ).length;
}

/**
 * Whether the main process should fire an armed restart now.
 *
 * Kept pure and separate from the view so the decision can be tested against thread snapshots
 * without a renderer. `progressingThreadCount` counts only the local primary environment:
 * restarting the desktop app tears down the server it hosts, so remote-environment threads are not
 * at risk and must not be able to block the restart forever.
 */
export function shouldAutoRestartNow(params: {
  readonly armed: AutoRestartArmed | undefined;
  readonly progressingThreadCount: number;
  readonly now: number;
}): boolean {
  if (params.armed === undefined) return false;
  // Expired arms are stood down by the ceiling, not fired. Firing here would restart under a user
  // who still has something running — the opposite of what arming asked for.
  if (autoRestartExpired(params.armed, params.now)) return false;
  return params.progressingThreadCount === 0;
}
