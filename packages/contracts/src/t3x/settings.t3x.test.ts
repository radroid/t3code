// Fork-owned coverage for t3x additions to the shared settings contracts.
//
// These cases deliberately live OUTSIDE `packages/contracts/src/settings.test.ts`.
// That file is upstream-owned and churns hard (8 commits in 30 days), and the fork's
// block sat at the same `describe` anchor upstream keeps inserting at — which produced
// a recurring add/add rebase conflict on the daily upstream sync (issue #29).
// Keeping fork tests in a fork-owned file removes that file from the conflict surface.
// See docs/t3x/SEAMS.md.
//
// The two decode helpers below are re-declared rather than imported because the
// upstream test file keeps them module-local.

import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ClientSettingsSchema, ClientSettingsPatch } from "../settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);

describe("ClientSettings needs-input notifications", () => {
  it("defaults needs-input notifications on for existing installs", () => {
    expect(decodeClientSettings({}).notifyOnNeedsInput).toBe(true);
  });

  it("honours an explicit opt-out", () => {
    expect(decodeClientSettings({ notifyOnNeedsInput: false }).notifyOnNeedsInput).toBe(false);
  });

  it("accepts the toggle in a client settings patch", () => {
    expect(decodeClientSettingsPatch({}).notifyOnNeedsInput).toBeUndefined();
    expect(decodeClientSettingsPatch({ notifyOnNeedsInput: false }).notifyOnNeedsInput).toBe(false);
  });
});
