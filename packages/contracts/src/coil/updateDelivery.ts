/**
 * Contract between the fork's update-delivery service (desktop main) and its toast (renderer),
 * kept out of the upstream `ipc.ts` to minimise sync conflicts (see `docs/coil/SEAMS.md`). Plain
 * interfaces, not Schema: values cross `contextBridge` and are validated at the relay manifest.
 */

/** What a build looks like to the renderer. Enough to name it and no more. */
export interface CoilUpdateBuild {
  /** 12 hex characters, comparable with `t3codeCommitHash`. */
  readonly shortSha: string;
  readonly version: string;
}

/**
 * Where delivery has got to, for exactly one announced build. The toast renders `staging` as
 * nothing, but it stays in the contract so logs distinguish downloading from idle, and so the
 * renderer can tell "no update" from "not actionable yet" before sending `restartNow`.
 */
export type CoilUpdateStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "staging"; readonly shortSha: string }
  | {
      readonly kind: "ready";
      readonly shortSha: string;
      readonly version: string;
      /**
       * Commit subjects in this build, newest first.
       *
       * All three fields below are optional on purpose. The manifest does not carry them yet, and
       * an older desktop shell hosting a newer bundle will not either — so the toast has to render
       * correctly without them rather than showing an empty disclosure or "built undefined ago".
       */
      readonly changes?: readonly string[];
      /** ISO 8601, from the manifest's existing `builtAt`. */
      readonly builtAt?: string;
      /** The workflow run that produced the build, for the age link. Needs `run_id`, not `run_number`. */
      readonly runUrl?: string;
    }
  | { readonly kind: "restarting" }
  | { readonly kind: "failed"; readonly message: string; readonly logPath?: string }
  /**
   * The install landed, confirmed on the boot after it.
   *
   * Shown once. On macOS the swap is fast enough that the restart is its own confirmation, but on
   * Windows the app is gone for minutes with no window and a Start-menu shortcut that reports it
   * does not exist — so coming back with nothing said leaves "did that work?" unanswered.
   */
  | { readonly kind: "updated"; readonly shortSha: string; readonly version: string }
  /**
   * The app came back as a different build than the one it was told to install.
   *
   * The case `installCommands.ts` warned about: without this comparison a silently failed install
   * is indistinguishable from a successful one. Carries both sides so the report says which build
   * was expected and what actually turned up.
   */
  | {
      readonly kind: "install-failed";
      readonly expectedShortSha: string;
      readonly expectedVersion: string;
      /** Absent when the running build carries no embedded commit hash at all. */
      readonly actualShortSha?: string;
      readonly actualVersion: string;
      readonly platform: string;
      readonly arch: string;
    };

export interface CoilUpdateState {
  readonly status: CoilUpdateStatus;
  /**
   * True once this install has applied at least one update through this path. Drives a one-time
   * note about macOS re-asking for permissions, which is true of every unsigned update and would
   * become wallpaper if repeated.
   */
  readonly hasUpdatedBefore: boolean;
}

export interface CoilUpdateBridge {
  getState: () => Promise<CoilUpdateState>;
  /** Returns an unsubscribe function. */
  onState: (listener: (state: CoilUpdateState) => void) => () => void;
  /**
   * Apply the staged build and restart.
   *
   * Refused unless the status is `ready`; the main process is single-flight, because two windows
   * mean two toasts and two possible clicks on one bundle.
   */
  restartNow: () => Promise<void>;
  /** Suppress the toast for this build only. Never suppresses the next one. */
  dismiss: (shortSha: string) => Promise<void>;
}
