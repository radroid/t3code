/**
 * Resolving *what* to replace, and refusing when replacing it would silently do the wrong thing:
 * every rejection maps to a failure that otherwise reports success. No `node:path`: these paths
 * are always POSIX (macOS-only), and Effect's `Path` service would make string math effectful.
 */

function posixDirname(path: string): string {
  const index = path.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return "/";
  return path.slice(0, index);
}

function posixBasename(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf("/");
  return index < 0 ? trimmed : trimmed.slice(index + 1);
}

export type InstallTargetResolution =
  | { readonly kind: "resolved"; readonly appBundlePath: string; readonly appName: string }
  | { readonly kind: "refused"; readonly refusal: InstallRefusal };

export type InstallRefusal =
  | { readonly kind: "translocated"; readonly execPath: string }
  | { readonly kind: "not-a-bundle"; readonly execPath: string }
  | { readonly kind: "name-mismatch"; readonly installed: string; readonly incoming: string };

export function describeRefusal(refusal: InstallRefusal): string {
  switch (refusal.kind) {
    case "translocated":
      return (
        "T3 Code is running from a randomised read-only copy created by macOS App Translocation, " +
        "so it cannot update itself. Move the app to /Applications once, reopen it, and updates " +
        "will work from then on."
      );
    case "not-a-bundle":
      return `Could not find the enclosing .app for ${refusal.execPath}, so there is nothing safe to replace.`;
    // Fires once per user, on the first build after the app is renamed. Worded as the one safe next
    // step rather than a fault, because the check is all that stops a rename leaving two installed
    // apps.
    case "name-mismatch":
      return (
        `The downloaded build is named "${refusal.incoming}" but the running app is ` +
        `"${refusal.installed}". That is expected the first time after the app was renamed. ` +
        "Installing it here would leave two copies, so open the downloaded .dmg and drag the app " +
        "to /Applications yourself, replacing the old one. Updates go back to being automatic " +
        "after that."
      );
  }
}

/**
 * macOS runs a quarantined app from a randomised read-only mount under
 * `/private/var/folders/.../AppTranslocation/<UUID>/d/...`. Relaunching `process.execPath` there
 * brings back the old bundle while post-install checks pass against the wrong process. Common:
 * the first launch after a manual dmg drag is exactly this case.
 */
export function isTranslocatedPath(execPath: string): boolean {
  return execPath.includes("/AppTranslocation/");
}

/** Walks up from the executable to the enclosing `.app`. */
export function findEnclosingAppBundle(execPath: string): string | undefined {
  let current = posixDirname(execPath);
  // Bounded rather than `while (true)`: a malformed path must fail closed, not spin.
  for (let depth = 0; depth < 12; depth += 1) {
    if (current.endsWith(".app")) return current;
    const parent = posixDirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * Resolve the bundle to replace from the running executable, never a hardcoded `/Applications`:
 * that would install a NEW app and leave the running one untouched for `~/Applications`, a second
 * copy, an MDM root-owned `/Applications`, or a read-only volume.
 */
export function resolveMacInstallTarget(args: {
  readonly execPath: string;
  /** The `.app` name found inside the mounted dmg. Read, never computed. */
  readonly incomingAppName: string;
}): InstallTargetResolution {
  if (isTranslocatedPath(args.execPath)) {
    return { kind: "refused", refusal: { kind: "translocated", execPath: args.execPath } };
  }

  const appBundlePath = findEnclosingAppBundle(args.execPath);
  if (appBundlePath === undefined) {
    return { kind: "refused", refusal: { kind: "not-a-bundle", execPath: args.execPath } };
  }

  const appName = posixBasename(appBundlePath);

  // The bundle name carries a stage label ("T3 Code (Beta)") and has changed with renames, so it is
  // read from the dmg, never computed. The old shell installer computed it and "always claimed
  // T3 Code.app — an app that does not exist — while a real install replaced T3 Code (Alpha).app".
  // Comparing the two names is what stops a rename from quietly producing two installed apps.
  if (appName !== args.incomingAppName) {
    return {
      kind: "refused",
      refusal: { kind: "name-mismatch", installed: appName, incoming: args.incomingAppName },
    };
  }

  return { kind: "resolved", appBundlePath, appName };
}

/**
 * Where the swap-ready copy is staged.
 *
 * Beside the final target, on the same volume, so the swap is a rename rather than a cross-device
 * copy. `mv` across volumes degrades into copy-then-delete, which would put the expensive work
 * back after the click — the exact thing staging exists to avoid.
 */
export function stagedBundlePath(appBundlePath: string): string {
  return `${appBundlePath}.coil-new`;
}
