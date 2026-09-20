import { describe, expect, it } from "vite-plus/test";

import { collectRequiredPackages } from "./verify-desktop-bundle.mjs";

const bundle = (source: string) => ({ size: source.length, read: () => Buffer.from(source) });

describe("collectRequiredPackages", () => {
  // Upstream #11410: the Electron main bundle inlines everything but its native externals, and
  // the stage installs only those. A require left inside an inlined dependency (x11 via
  // @crowecawcaw/xa11y, ajv via electron-updater) has no node_modules to resolve to, by design.
  it("requires only native externals from the inlined desktop main bundle", () => {
    const files = new Map([
      [
        "apps/desktop/dist-electron/main.cjs",
        bundle(
          'require("x11"); require("ajv/dist/runtime/validation_error"); require("@napi-rs/keyring");',
        ),
      ],
    ]);
    expect([...collectRequiredPackages(files).keys()]).toEqual(["@napi-rs/keyring"]);
  });

  it("requires only the CLI's native externals from the inlined server bundle", () => {
    const files = new Map([
      [
        "apps/server/dist/bin.mjs",
        bundle(
          'import * as E from "effect"; require("ajv/dist/runtime/validation_error"); require("node-pty");',
        ),
      ],
    ]);
    expect([...collectRequiredPackages(files).keys()]).toEqual(["node-pty"]);
  });
});
