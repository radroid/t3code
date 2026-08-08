/**
 * The contract between the fork's update-delivery service (desktop main) and its toast (renderer).
 *
 * Fork-owned, and deliberately in its own file: `ipc.ts` is an upstream file this fork already
 * edits, and every line added there is a line a future upstream sync can conflict on. `ipc.ts`
 * imports one type from here and adds one optional bridge member — see `docs/t3x/SEAMS.md`.
 *
 * These are plain interfaces rather than `Schema` structs, matching `DesktopBridge`'s other
 * members. The values cross `contextBridge`, which structured-clones them; the validation that
 * matters happens where the data enters the process, on the manifest the relay serves.
 */

/** What a build looks like to the renderer. Enough to name it and no more. */
export interface T3xUpdateBuild {
  /** 12 hex characters, comparable with `t3codeCommitHash`. */
  readonly shortSha: string;
  readonly version: string;
}

/**
 * Where delivery has got to, for exactly one announced build.
 *
 * `staging` is a real state that the toast deliberately renders as nothing — see
 * `apps/web/src/components/t3x/updateToast.logic.ts`. It is in the contract anyway because
 * "downloading" and "idle" are different things to log, and because the renderer needs to
 * distinguish "no update" from "an update you cannot act on yet" when it decides whether a
 * `restartNow` call is worth sending.
 */
export type T3xUpdateStatus =
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
  | { readonly kind: "failed"; readonly message: string; readonly logPath?: string };

export interface T3xUpdateState {
  readonly status: T3xUpdateStatus;
  /**
   * True once this install has applied at least one update through this path. Drives a one-time
   * note about macOS re-asking for permissions, which is true of every unsigned update and would
   * become wallpaper if repeated.
   */
  readonly hasUpdatedBefore: boolean;
}

export interface T3xUpdateBridge {
  getState: () => Promise<T3xUpdateState>;
  /** Returns an unsubscribe function. */
  onState: (listener: (state: T3xUpdateState) => void) => () => void;
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
