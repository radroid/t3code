/**
 * What the update toast shows, as a pure function of the delivery state.
 *
 * Split from the component in the style of `ProviderUpdateLaunchNotification.logic.ts`, so the
 * state machine can be tested without rendering. The interesting cases here are the ones where
 * showing nothing is correct — a toast that appears while an update is merely downloading trains
 * people to ignore it.
 */

export type UpdateDeliveryStatus =
  | { readonly kind: "idle" }
  /** Downloading and copying into place. Deliberately invisible. */
  | { readonly kind: "staging"; readonly shortSha: string }
  | { readonly kind: "ready"; readonly shortSha: string; readonly version: string }
  | { readonly kind: "restarting" }
  | { readonly kind: "failed"; readonly message: string; readonly logPath?: string };

export interface UpdateToastInput {
  readonly status: UpdateDeliveryStatus;
  readonly dismissedShortSha: string | undefined;
  readonly isElectron: boolean;
  /** True once this app has installed at least one update through this path. */
  readonly hasUpdatedBefore: boolean;
}

export type UpdateToastView =
  | { readonly kind: "hidden" }
  | {
      readonly kind: "ready";
      readonly title: string;
      readonly description: string;
      readonly actionLabel: string;
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

      return {
        kind: "ready",
        title: "Update ready",
        description:
          `Build ${input.status.shortSha} is staged and will apply on restart.` +
          (input.hasUpdatedBefore ? "" : FIRST_UPDATE_PERMISSION_NOTE),
        actionLabel: "Restart",
        shortSha: input.status.shortSha,
        dismissible: true,
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
 */
export function shouldSendRestart(view: UpdateToastView): boolean {
  return view.kind === "ready";
}
