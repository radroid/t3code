import { describe, expect, it } from "vite-plus/test";

import {
  findEnclosingAppBundle,
  isTranslocatedPath,
  resolveMacInstallTarget,
  stagedBundlePath,
} from "./installTarget.ts";

const APP = "/Applications/T3 Code (Alpha).app";
const EXEC = `${APP}/Contents/MacOS/T3 Code (Alpha)`;

describe("isTranslocatedPath", () => {
  it("detects a translocated execPath", () => {
    expect(
      isTranslocatedPath(
        "/private/var/folders/x9/abc/T/AppTranslocation/1E2D-4F/d/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)",
      ),
    ).toBe(true);
  });

  it("does not flag a normal install", () => {
    expect(isTranslocatedPath(EXEC)).toBe(false);
  });

  it("does not flag a path that merely mentions the word", () => {
    expect(isTranslocatedPath("/Users/me/AppTranslocationNotes/T3.app/Contents/MacOS/T3")).toBe(false);
  });
});

describe("findEnclosingAppBundle", () => {
  it("walks up to the .app", () => {
    expect(findEnclosingAppBundle(EXEC)).toBe(APP);
  });

  it("works for an app installed outside /Applications", () => {
    const home = "/Users/me/Applications/T3 Code (Alpha).app";
    expect(findEnclosingAppBundle(`${home}/Contents/MacOS/T3 Code (Alpha)`)).toBe(home);
  });

  it("returns undefined when there is no enclosing bundle", () => {
    expect(findEnclosingAppBundle("/usr/local/bin/t3code")).toBeUndefined();
  });
});

describe("resolveMacInstallTarget", () => {
  it("resolves the bundle from the running executable", () => {
    const result = resolveMacInstallTarget({
      execPath: EXEC,
      incomingAppName: "T3 Code (Alpha).app",
    });
    expect(result).toEqual({
      kind: "resolved",
      appBundlePath: APP,
      appName: "T3 Code (Alpha).app",
    });
  });

  it("resolves an app installed outside /Applications", () => {
    // Never hardcode /Applications. Installing there while running from somewhere else would
    // create a second app and leave the running one untouched — a success that changes nothing.
    const home = "/Users/me/Applications/T3 Code (Alpha).app";
    const result = resolveMacInstallTarget({
      execPath: `${home}/Contents/MacOS/T3 Code (Alpha)`,
      incomingAppName: "T3 Code (Alpha).app",
    });
    expect(result.kind === "resolved" && result.appBundlePath).toBe(home);
  });

  it("refuses when running translocated", () => {
    // The relaunch would re-exec the read-only translocated bundle, so the app would come back on
    // the OLD build while post-install verification passed against the wrong process.
    const result = resolveMacInstallTarget({
      execPath:
        "/private/var/folders/x9/abc/T/AppTranslocation/1E2D-4F/d/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)",
      incomingAppName: "T3 Code (Alpha).app",
    });
    expect(result.kind === "refused" && result.refusal.kind).toBe("translocated");
  });

  it("refuses when the incoming bundle has a different name", () => {
    // productName here is "T3 Code (Alpha)", not "T3 Code". The shell installer's own comment
    // records the consequence of guessing: it claimed an app that does not exist while a real
    // install replaced a differently-named one.
    const result = resolveMacInstallTarget({ execPath: EXEC, incomingAppName: "T3 Code.app" });
    expect(result.kind === "refused" && result.refusal.kind).toBe("name-mismatch");
  });

  it("refuses when the executable is not inside a bundle", () => {
    const result = resolveMacInstallTarget({
      execPath: "/usr/local/bin/t3code",
      incomingAppName: "T3 Code (Alpha).app",
    });
    expect(result.kind === "refused" && result.refusal.kind).toBe("not-a-bundle");
  });
});

describe("stagedBundlePath", () => {
  it("stages beside the target, on the same volume", () => {
    // Same directory so the swap is a rename. A staging dir on another volume would make `mv`
    // degrade into copy-then-delete, putting the expensive work back after the click.
    expect(stagedBundlePath(APP)).toBe(`${APP}.coil-new`);
  });
});
