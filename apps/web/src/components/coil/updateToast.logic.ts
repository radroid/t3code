/**
 * What the update toast shows, as a pure function of the delivery state.
 *
 * Split from the component in the style of `ProviderUpdateLaunchNotification.logic.ts`, so the
 * state machine can be tested without rendering. The interesting cases here are the ones where
 * showing nothing is correct — a toast that appears while an update is merely downloading trains
 * people to ignore it.
 */

import type { CoilUpdateStatus } from "@t3tools/contracts";

import { isMacPlatform, isWindowsPlatform } from "../../lib/utils.ts";

/**
 * Aliased rather than redeclared. The same union crosses the IPC boundary, and two copies of it
 * would drift the moment one side gained a state — with the renderer silently falling through to
 * "show nothing", which is the failure this whole feature exists to remove.
 */
export type UpdateDeliveryStatus = CoilUpdateStatus;

/**
 * How long an armed auto-restart is allowed to wait for the app to go quiet.
 *
 * There has to be a ceiling. Idleness is derived from `threadIsProgressing` in
 * `apps/server/src/coil/autoResume/guards.ts`, which reads `session.status` and
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
    }
  | {
      readonly kind: "updated";
      readonly title: string;
      readonly description: string;
      readonly dismissible: true;
    }
  | {
      readonly kind: "install-failed";
      readonly title: string;
      readonly description: string;
      /** Opens a pre-filled new-issue form. The user reviews and submits; nothing is filed for them. */
      readonly reportUrl: string;
      readonly reportLabel: string;
      readonly dismissible: true;
    };

/** Where a failed install gets reported. The fork's own repo, not upstream's. */
const FORK_ISSUES_NEW_URL = "https://github.com/radroid/t3code/issues/new";

/**
 * A pre-filled issue, opened for review rather than filed automatically.
 *
 * Deliberately a link and not a `gh issue create`. The repo is public, so anything posted here is
 * world-readable, and an app that files publicly from the user's account without showing them the
 * text first is doing something they cannot take back. A link also means no dependency on `gh`
 * being installed and authenticated, and no chance of an install that fails on every launch
 * opening an issue on every launch.
 *
 * Build identity only. The failing step's message can embed local filesystem paths — on Windows
 * those contain the username — and none of that is needed to identify which update broke.
 */
export function buildInstallFailureReportUrl(input: {
  readonly expectedShortSha: string;
  readonly expectedVersion: string;
  readonly actualShortSha: string | undefined;
  readonly actualVersion: string;
  readonly platform: string;
  readonly arch: string;
}): string {
  const body = [
    "The app restarted to install an update and came back as a different build.",
    "",
    "| | Expected | Actual |",
    "| --- | --- | --- |",
    `| Commit | \`${input.expectedShortSha}\` | \`${input.actualShortSha ?? "none reported"}\` |`,
    `| Version | \`${input.expectedVersion}\` | \`${input.actualVersion}\` |`,
    "",
    `Platform: \`${input.platform}\` \`${input.arch}\``,
    "",
    "_Filed from the in-app update toast. Build identity only — no logs or paths._",
  ].join("\n");

  const query = new URLSearchParams({
    title: `Update did not apply: expected ${input.expectedShortSha}, got ${input.actualShortSha ?? "no commit hash"}`,
    body,
    labels: "bug",
  });
  return `${FORK_ISSUES_NEW_URL}?${query.toString()}`;
}

/**
 * macOS refuses to let one app modify another's bundle unless both are signed by the same
 * development team, and installing an update is exactly that modification — the swap in
 * `installCommands.ts` replaces the bundle in /Applications. These builds *are* signed, but with a
 * self-signed certificate carrying no team identifier, so there is no team for macOS to match and
 * the App Management dialog is raised the first time an update lands.
 *
 * Asked once. The grant keys to the app's designated requirement, stable since #70/PR #85, so
 * allowing it survives later updates — confirmed 2026-08-12 across builds 102 to 105.
 *
 * **This note used to say the builds were unsigned, and to expect screen-recording and automation
 * prompts. All three were wrong**, and expensively so: PR #85 fixed the signing without updating
 * this string, so it kept promising the symptom of a bug that no longer existed — while naming two
 * services the app never requests. There is no `desktopCapturer`, `getDisplayMedia`, `osascript` or
 * Apple Event use anywhere in `apps/desktop/src`. The one dialog users actually see was never
 * either of them, and the wrong wording sent the diagnosis after the signature rather than the
 * missing team.
 *
 * `NSUpdateSecurityPolicy` is not an escape hatch — its `AllowProcesses` map is keyed *by team
 * identifier*, so it needs precisely the thing this build lacks. Retiring the dialog for good means
 * a paid Developer ID, which would also retire the quarantine step on the download page.
 *
 * Shown once, on the first update only. Repeating it every time would make it wallpaper, and it
 * is the kind of thing a user needs to understand once and then recognise.
 */
const FIRST_UPDATE_PERMISSION_NOTE =
  " macOS asks once for App Management — a dialog saying the app wants access to data from other apps. Allow it: updating means replacing the app in /Applications, and these builds carry no Apple team identifier for macOS to match it against. It will not ask again.";

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
  "T3 Coil will close, install the update, and reopen itself. This usually takes a few minutes, and the window and Start-menu shortcut are unavailable until it finishes.";

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
          description: "T3 Coil will restart once nothing is running. You can keep working.",
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
            : "Restart to update T3 Coil.") +
          (expired ? TIMED_OUT_NOTE : "") +
          // Gated on macOS, not merely on "first update". App Management is a macOS concept —
          // every Windows and Linux user was being told to expect a dialog their OS never shows.
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

    case "updated":
      // Confirmed on the boot after the install, not claimed before it. Matters most on Windows,
      // where the app is gone for minutes and coming back silently leaves "did that work?"
      // unanswered — which is how a successful update gets reported as a broken one.
      return {
        kind: "updated",
        title: `Updated to ${input.status.version}`,
        description: `Now running ${input.status.shortSha}.`,
        dismissible: true,
      };

    case "install-failed": {
      // The app is running a DIFFERENT build than the one it restarted to install. Silent here
      // would mean a failed update is indistinguishable from a successful one — the exact gap
      // `installCommands.ts` describes and that nothing had been checking.
      const actual = input.status.actualShortSha;
      return {
        kind: "install-failed",
        title: "Update did not apply",
        description:
          `T3 Coil restarted to install ${input.status.expectedVersion} but came back as ` +
          `${actual === undefined ? "a build that reports no commit" : actual}. ` +
          "The previous version is still installed and still works.",
        reportUrl: buildInstallFailureReportUrl({
          expectedShortSha: input.status.expectedShortSha,
          expectedVersion: input.status.expectedVersion,
          actualShortSha: actual,
          actualVersion: input.status.actualVersion,
          platform: input.status.platform,
          arch: input.status.arch,
        }),
        reportLabel: "Report this",
        dismissible: true,
      };
    }
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
