/**
 * Building the install command lines, kept separate from running them.
 *
 * The ordering below is not stylistic. Both platforms have a sequence that works and several that
 * fail while reporting success, so the sequence is expressed as data and asserted in tests rather
 * than living inside a function that shells out.
 */

export interface Command {
  readonly bin: string;
  readonly args: readonly string[];
  /** Detached commands outlive this process. Only the Windows installer needs it. */
  readonly detached?: true;
}

/**
 * macOS staging: mount, copy beside the target, de-quarantine, unmount.
 *
 * All of it runs in the BACKGROUND, before the user is offered a restart. If any of this happened
 * after the click, "the click is an instant restart" would be false — a 470 MB copy plus a
 * recursive xattr walk over tens of thousands of files is tens of seconds with the UI stuck.
 *
 * Two traps encoded here:
 *
 * - The mount point is under `$TMPDIR`, not `/Volumes`. Mounting under `/Volumes` from inside the
 *   app raises the macOS "access files on a removable volume" prompt, which a background step has
 *   no way to answer.
 * - The copy destination must NOT already exist. BSD `cp -R src.app dst.app` copies *into*
 *   `dst.app` when it exists, nesting the new build inside the old one and exiting 0.
 */
export function macStagingCommands(args: {
  readonly dmgPath: string;
  readonly mountPoint: string;
  readonly sourceAppPath: string;
  readonly stagedAppPath: string;
}): readonly Command[] {
  return [
    ...macAttachCommands({ dmgPath: args.dmgPath, mountPoint: args.mountPoint }),
    ...macCopyCommands({
      sourceAppPath: args.sourceAppPath,
      stagedAppPath: args.stagedAppPath,
    }),
    macDetachCommand(args.mountPoint),
  ];
}

/**
 * Split out because `sourceAppPath` is not knowable until the dmg is mounted.
 *
 * The `.app` name inside the dmg must be READ, never computed — `resolveMacInstallTarget` refuses
 * an install when the mounted name differs from the installed one, and that check is worthless if
 * both sides come from the same guess. So the caller attaches, lists the mount point, and only
 * then can build the copy step.
 */
export function macAttachCommands(args: {
  readonly dmgPath: string;
  readonly mountPoint: string;
}): readonly Command[] {
  return [
    // Belt and braces: `fetch` does not set com.apple.quarantine, unlike LaunchServices-aware
    // downloaders, but stripping it costs nothing and a quarantined dmg fails to attach cleanly.
    { bin: "xattr", args: ["-d", "com.apple.quarantine", args.dmgPath] },
    {
      bin: "hdiutil",
      args: ["attach", args.dmgPath, "-nobrowse", "-readonly", "-mountpoint", args.mountPoint],
    },
  ];
}

export function macCopyCommands(args: {
  readonly sourceAppPath: string;
  readonly stagedAppPath: string;
}): readonly Command[] {
  return [
    // Remove any leftover staged bundle first, so `cp -R` creates rather than nests.
    { bin: "rm", args: ["-rf", args.stagedAppPath] },
    { bin: "cp", args: ["-R", args.sourceAppPath, args.stagedAppPath] },
    { bin: "xattr", args: ["-dr", "com.apple.quarantine", args.stagedAppPath] },
  ];
}

/**
 * Always runs, including after a failed copy — a dmg left attached survives this process and the
 * next attach to the same mount point fails, so one bad update would poison every later one.
 */
export function macDetachCommand(mountPoint: string): Command {
  return { bin: "hdiutil", args: ["detach", mountPoint, "-force"] };
}

/**
 * The swap, run on the click. Everything expensive already happened.
 *
 * Delete-then-rename, in that order and no other. Renaming onto an existing bundle does not
 * replace it, and copying before the delete is what nests one app inside another. The window where
 * nothing is installed is a single rename long — and the alternative, deleting after a failed
 * copy, leaves the user with no app at all.
 */
export function macSwapCommands(args: {
  readonly targetAppPath: string;
  readonly stagedAppPath: string;
}): readonly Command[] {
  return [
    { bin: "rm", args: ["-rf", args.targetAppPath] },
    { bin: "mv", args: [args.stagedAppPath, args.targetAppPath] },
  ];
}

/**
 * Windows install. A completely different shape, and the design has to say so.
 *
 * The NSIS installer needs the app's own files, so the app cannot wait for it to finish — a silent
 * install that hits a running app is the documented cause of installers that hang forever with no
 * UI. The only sequence that works is: spawn detached, quit immediately, let the installer relaunch.
 *
 * That means `DesktopLifecycle.relaunch` is the wrong primitive here. macOS restarts itself;
 * Windows is restarted *by* the installer.
 *
 * `/S` alone installs silently and does not start the app afterwards, which would leave the user
 * staring at a closed app wondering what happened. `--force-run` is what electron-updater's own
 * NsisUpdater passes, alongside `--updated`.
 */
export function windowsInstallCommand(installerPath: string): Command {
  return { bin: installerPath, args: ["/S", "--force-run", "--updated"], detached: true };
}

/**
 * Windows verification happens on the NEXT startup, not in-process.
 *
 * By the time the installer has done anything, this process is gone — there is nobody left to
 * check. So the target is recorded before quitting and compared against `t3codeCommitHash` when
 * the app comes back. Without this, a silently failed install is indistinguishable from a
 * successful one, which is exactly issue #47's complaint.
 */
export function verifyPostInstall(args: {
  readonly expectedShortSha: string;
  readonly actualCommitHash: string | undefined;
}): { readonly kind: "installed" } | { readonly kind: "did-not-apply"; readonly expected: string } {
  const actual = args.actualCommitHash?.trim().toLowerCase();
  if (actual !== undefined && actual.startsWith(args.expectedShortSha.toLowerCase())) {
    return { kind: "installed" };
  }
  return { kind: "did-not-apply", expected: args.expectedShortSha };
}
