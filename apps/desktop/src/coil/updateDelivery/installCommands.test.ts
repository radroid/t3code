import { describe, expect, it } from "vite-plus/test";

import {
  macStagingCommands,
  macSwapCommands,
  verifyPostInstall,
  windowsInstallCommand,
} from "./installCommands.ts";

const MAC = {
  dmgPath: "/Users/me/Library/Application Support/T3/staging/T3Code-abc123def456-arm64.dmg",
  mountPoint: "/var/folders/x9/T/coil-dmg-abc123",
  sourceAppPath: "/var/folders/x9/T/coil-dmg-abc123/T3 Coil (Alpha).app",
  stagedAppPath: "/Applications/T3 Coil (Alpha).app.coil-new",
};

describe("macStagingCommands", () => {
  const commands = macStagingCommands(MAC);
  const bins = commands.map((command) => command.bin);

  it("mounts under TMPDIR rather than /Volumes", () => {
    // Mounting under /Volumes from inside the app raises the "removable volume" TCC prompt, which
    // a background staging step cannot answer.
    const attach = commands.find((command) => command.args[0] === "attach");
    expect(attach?.args).toContain("-mountpoint");
    expect(attach?.args).toContain(MAC.mountPoint);
    expect(attach?.args.join(" ")).not.toContain("/Volumes");
  });

  it("removes any leftover staged bundle before copying", () => {
    // BSD `cp -R src.app dst.app` copies INTO dst.app when it exists — nesting the new build
    // inside the old one and exiting 0. A success that installs nothing.
    const removeIndex = commands.findIndex(
      (command) => command.bin === "rm" && command.args.includes(MAC.stagedAppPath),
    );
    const copyIndex = bins.indexOf("cp");
    expect(removeIndex).toBeGreaterThanOrEqual(0);
    expect(removeIndex).toBeLessThan(copyIndex);
  });

  it("strips quarantine from the copy, recursively, before detaching", () => {
    const stripIndex = commands.findIndex(
      (command) => command.bin === "xattr" && command.args.includes("-dr"),
    );
    const detachIndex = commands.findIndex((command) => command.args[0] === "detach");
    expect(stripIndex).toBeLessThan(detachIndex);
    expect(commands[stripIndex]?.args).toContain(MAC.stagedAppPath);
  });

  it("always detaches, even though the copy came first", () => {
    expect(bins.at(-1)).toBe("hdiutil");
    expect(commands.at(-1)?.args[0]).toBe("detach");
  });

  it("does all the expensive work here, not in the swap", () => {
    // The user was promised that the click is instant. If the mount or the copy moved into the
    // swap, that promise is quietly broken by tens of seconds.
    expect(bins).toContain("cp");
    expect(bins).toContain("hdiutil");
  });
});

describe("macSwapCommands", () => {
  const commands = macSwapCommands({
    targetAppPath: "/Applications/T3 Coil (Alpha).app",
    stagedAppPath: "/Applications/T3 Coil (Alpha).app.coil-new",
  });

  it("deletes the target, then renames onto it", () => {
    // Renaming onto an existing bundle does not replace it. The order is load-bearing.
    expect(commands.map((command) => command.bin)).toEqual(["rm", "mv"]);
  });

  it("is only a rename, so the click stays instant", () => {
    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.bin)).not.toContain("cp");
  });
});

describe("windowsInstallCommand", () => {
  const command = windowsInstallCommand("C:\\Users\\me\\AppData\\T3\\T3Code-abc-x64.exe");

  it("runs detached, because the app cannot wait for it", () => {
    // The installer needs the app's own files. A silent install that hits a running app is the
    // documented cause of installers that hang forever with no UI.
    expect(command.detached).toBe(true);
  });

  it("passes --force-run so the app comes back", () => {
    // `/S` alone installs silently and does NOT relaunch, leaving the user at a closed app.
    expect(command.args).toContain("/S");
    expect(command.args).toContain("--force-run");
  });
});

describe("verifyPostInstall", () => {
  it("confirms an install that applied", () => {
    expect(
      verifyPostInstall({ expectedShortSha: "abc123def456", actualCommitHash: "abc123def456" }),
    ).toEqual({ kind: "installed" });
  });

  it("accepts a full-length hash with the expected prefix", () => {
    expect(
      verifyPostInstall({
        expectedShortSha: "abc123def456",
        actualCommitHash: "abc123def456789012345678901234567890abcd",
      }).kind,
    ).toBe("installed");
  });

  it("reports an install that silently did nothing", () => {
    // Windows has no in-process verification — the process is gone by the time the installer runs.
    // Without this next-startup check, a failed install is indistinguishable from a successful one.
    expect(
      verifyPostInstall({ expectedShortSha: "abc123def456", actualCommitHash: "999999999999" }),
    ).toEqual({ kind: "did-not-apply", expected: "abc123def456" });
  });

  it("reports a missing hash as not applied", () => {
    expect(
      verifyPostInstall({ expectedShortSha: "abc123def456", actualCommitHash: undefined }).kind,
    ).toBe("did-not-apply");
  });
});
