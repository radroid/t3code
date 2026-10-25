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
 * macOS staging (mount, copy beside the target, de-quarantine, unmount), all run in the
 * background before a restart is offered so the click stays instant. Mount under `$TMPDIR`, not
 * `/Volumes` (that raises a removable-volume prompt nobody can answer). The copy destination must
 * not exist: BSD `cp -R src.app dst.app` nests into an existing `dst.app` and still exits 0.
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
 * Split out because `sourceAppPath` is not knowable until the dmg is mounted. The `.app` name must
 * be read from the mount, never computed: `resolveMacInstallTarget` refuses a name mismatch, and
 * that check is worthless if both sides come from the same guess.
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
 * The swap, run on the click. Delete-then-rename, in that order only: renaming onto an existing
 * bundle does not replace it, and copying before the delete nests one app inside another.
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
 * Windows install: spawn detached, quit immediately, let the installer relaunch. NSIS needs the
 * app's own files and a silent install that hits a running app hangs forever, so
 * `DesktopLifecycle.relaunch` is the wrong primitive. `/S` alone does not restart the app;
 * `--force-run` (with `--updated`) is what electron-updater's NsisUpdater passes.
 */
export function windowsInstallCommand(installerPath: string): Command {
  return { bin: installerPath, args: ["/S", "--force-run", "--updated"], detached: true };
}

/**
 * Windows verification happens on the next startup: by the time the installer runs, this process
 * is gone. The target is recorded before quitting and compared against `t3codeCommitHash` on
 * return, otherwise a silently failed install looks like a successful one.
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
