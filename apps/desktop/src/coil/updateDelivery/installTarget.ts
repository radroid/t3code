/**
 * Resolving *what* to replace, and refusing when replacing it would silently do the wrong thing.
 *
 * Every rejection here maps to a failure that otherwise reports success. That is the whole reason
 * this is a separate, pure, heavily-tested module rather than three lines inside the installer.
 *
 * No `node:path` import: the repo routes filesystem paths through Effect's `Path` service, and
 * pulling that in would make this module effectful for what is entirely string arithmetic. These
 * paths are always POSIX — the bundle-walking logic below is macOS-only by construction — so two
 * local helpers are both sufficient and cheaper than a service dependency.
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
    case "name-mismatch":
      return (
        `The downloaded build is named "${refusal.incoming}" but the running app is ` +
        `"${refusal.installed}". Installing it would create a second app and leave this one ` +
        "untouched, so it was refused."
      );
  }
}

/**
 * macOS runs a quarantined app from a randomised read-only mount under
 * `/private/var/folders/.../AppTranslocation/<UUID>/d/...` rather than from where the user put it.
 *
 * This is the sharpest trap in the whole feature. `DesktopLifecycle.relaunch` re-execs
 * `process.execPath`; under translocation that points into the read-only snapshot. An installer
 * that wrote to /Applications anyway would then relaunch the *old* translocated bundle, and the
 * post-install check would pass because it verified the wrong process. Silent success, wrong
 * result — the precise failure shape of issue #47.
 *
 * The first launch after a manual dmg drag is exactly this case, so it is common, not exotic.
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
 * Resolve the bundle to replace from the running executable.
 *
 * Deliberately never hardcodes `/Applications`. The existing shell installer does, and its own
 * dry-run warns about the consequence: a real install "would create a NEW app and leave whatever
 * you currently run untouched". Moving that logic in-process removes the human who reads the
 * warning, so the path has to come from the process itself. Real cases this covers:
 * `~/Applications`, a second copy, a root-owned `/Applications` under MDM, a read-only volume.
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

  // `resolveDesktopProductName` returns `desktopPackageJson.productName`, which is
  // "T3 Code (Alpha)" on this fork — not "T3 Code". The shell installer records what happens when
  // this is computed rather than read: it "always claimed T3 Code.app — an app that does not
  // exist — while a real install replaced T3 Code (Alpha).app". Comparing the two names is what
  // stops a rename from quietly producing two installed apps.
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
