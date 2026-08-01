import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canSteerActiveThread, providerSupportsSteering } from "./composerSteering.logic";

describe("providerSupportsSteering", () => {
  it("allows the drivers whose adapters fold a mid-turn send into the running turn", () => {
    for (const driver of ["claudeAgent", "cursor", "grok", "opencode"]) {
      expect(providerSupportsSteering(ProviderDriverKind.make(driver))).toBe(true);
    }
  });

  it("refuses codex, which always opens a turn rather than steering", () => {
    // CodexSessionRuntime issues `turn/start` unconditionally and overwrites
    // activeTurnId; the protocol's `turn/steer` RPC is never called.
    expect(providerSupportsSteering(ProviderDriverKind.make("codex"))).toBe(false);
  });

  it("fails closed for an unknown or absent driver", () => {
    // An allowlist, not a denylist: a refused steer is invisible to the user
    // (the send command has already succeeded by the time the adapter refuses),
    // so an unrecognised driver must queue rather than risk losing a message.
    expect(providerSupportsSteering(ProviderDriverKind.make("some-future-driver"))).toBe(false);
    expect(providerSupportsSteering(null)).toBe(false);
    expect(providerSupportsSteering(undefined)).toBe(false);
  });
});

describe("canSteerActiveThread", () => {
  const steerable = {
    phase: "running",
    isSendBusy: false,
    isRevertingCheckpoint: false,
    provider: ProviderDriverKind.make("claudeAgent"),
  };

  it("steers a running turn on a capable provider", () => {
    expect(canSteerActiveThread(steerable)).toBe(true);
  });

  it("does not steer a thread that is not running", () => {
    expect(canSteerActiveThread({ ...steerable, phase: "idle" })).toBe(false);
  });

  it("does not steer while a local dispatch is still in flight", () => {
    // The immediate-send path bails on isSendBusy, so a submit here would be
    // dropped rather than sent; queuing keeps the message.
    expect(canSteerActiveThread({ ...steerable, isSendBusy: true })).toBe(false);
  });

  it("does not steer while a checkpoint revert is in progress", () => {
    expect(canSteerActiveThread({ ...steerable, isRevertingCheckpoint: true })).toBe(false);
  });

  it("does not steer a provider that opens a new turn instead", () => {
    expect(canSteerActiveThread({ ...steerable, provider: ProviderDriverKind.make("codex") })).toBe(
      false,
    );
  });
});
