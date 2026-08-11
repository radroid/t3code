import { assert, describe, it } from "@effect/vitest";

import {
  assetFileName,
  desktopProductName,
  fillCommand,
  loadInstructions,
  REPO_ROOT,
  renderReleaseNotes,
} from "./render-release-notes.mjs";

const instructions = loadInstructions(REPO_ROOT);

const render = (shortSha = "abc1234") =>
  renderReleaseNotes({ instructions, sha: `${shortSha}0000000000000000000000000000000`, shortSha });

describe("install-instructions.json", () => {
  // This is the assertion that makes the cached bundle name safe. The name in the JSON duplicates
  // what electron-builder actually produces, and issue #71 renames the fork — so without this,
  // the rename silently invalidates every `xattr` command the fork publishes, and the only
  // symptom is a reader pasting a command that answers "No such file or directory".
  it("caches the same app bundle name the desktop build produces", () => {
    assert.strictEqual(instructions.appBundleName, desktopProductName(REPO_ROOT));
  });

  it("covers exactly the platforms the release workflow publishes assets for", () => {
    assert.deepStrictEqual(
      instructions.platforms.map((platform) => platform.assetPlatform).toSorted(),
      ["darwin-arm64", "win32-x64"],
    );
  });

  it("gives every platform a support line, because the matrix is not obvious", () => {
    for (const platform of instructions.platforms) {
      assert.isAbove(platform.support.length, 0, `${platform.id} has no support line`);
      assert.isAbove(platform.steps.length, 0, `${platform.id} has no steps`);
    }
  });
});

describe("fillCommand", () => {
  it("substitutes the bundle name and the downloaded file", () => {
    assert.strictEqual(
      fillCommand('xattr -dr com.apple.quarantine "/Applications/{app}.app"', {
        app: "T3 Code (Alpha)",
        file: "ignored",
      }),
      'xattr -dr com.apple.quarantine "/Applications/T3 Code (Alpha).app"',
    );
    assert.strictEqual(
      fillCommand("Unblock-File -Path .\\{file}", { app: "ignored", file: "T3Code-abc-x64.exe" }),
      "Unblock-File -Path .\\T3Code-abc-x64.exe",
    );
  });

  // A half-substituted command is worse than no command: it still looks copy-pasteable, and the
  // error it produces in a terminal reads like the reader's mistake rather than ours.
  it("refuses a template with a placeholder it does not know", () => {
    assert.throws(
      () => fillCommand("open {somethingElse}", { app: "a", file: "b" }),
      /Unknown placeholder \{somethingElse\}/u,
    );
  });
});

describe("assetFileName", () => {
  // .github/workflows/t3x-release.yml stages `staged/T3Code-${SHORT_SHA}-${ARCH}.${ASSET_EXT}`.
  // If that naming changes, the Windows command tells readers to unblock a file they do not have.
  it("matches the names the release workflow stages", () => {
    const [mac, win] = instructions.platforms;
    assert.isDefined(mac);
    assert.isDefined(win);
    assert.strictEqual(assetFileName(mac, "abc1234"), "T3Code-abc1234-arm64.dmg");
    assert.strictEqual(assetFileName(win, "abc1234"), "T3Code-abc1234-x64.exe");
  });
});

describe("renderReleaseNotes", () => {
  it("names the build and every platform", () => {
    const notes = render();
    assert.match(notes, /Automated fork build of/u);
    for (const platform of instructions.platforms) {
      assert.include(notes, `### ${platform.name}`);
      assert.include(notes, platform.support);
    }
  });

  it("leaves no unresolved placeholder in the published text", () => {
    assert.isFalse(/\{\w+\}/u.test(render()));
  });

  it("carries the real asset name for the sha it was given", () => {
    assert.include(render("deadbee"), "T3Code-deadbee-x64.exe");
  });

  // The wording is the point of issue #72: Gatekeeper does not say "unidentified developer" for
  // this bundle, it says damaged — and a reader told to expect a "warning" concludes the download
  // is corrupt and gives up. If someone softens this copy, this test should stop them.
  it("says the app will be called damaged, and that right-click Open does not help", () => {
    const notes = render();
    assert.match(notes, /is damaged and should be moved to the Trash/u);
    assert.match(notes, /right-click → Open does \*\*not\*\*/u);
  });

  it("puts the /Applications move before the quarantine command", () => {
    const notes = render();
    assert.isBelow(
      notes.indexOf("Drag the app to /Applications"),
      notes.indexOf("xattr -dr"),
      "App Translocation is invisible when it happens, so the move has to come first",
    );
  });

  it("links the download page rather than referring to instructions it does not link", () => {
    assert.include(render(), instructions.downloadPageUrl);
  });
});
