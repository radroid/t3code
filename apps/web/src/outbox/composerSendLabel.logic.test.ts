import { describe, expect, it } from "vite-plus/test";

import { resolveComposerSendLabel } from "./composerSendLabel.logic";

describe("resolveComposerSendLabel", () => {
  it("labels Send when connected, idle, and the outbox is empty", () => {
    expect(
      resolveComposerSendLabel({
        connectionState: "connected",
        activeThreadBusy: false,
        queueCount: 0,
      }),
    ).toBe("Send");
  });

  it("labels Queue while the active thread is busy", () => {
    expect(
      resolveComposerSendLabel({
        connectionState: "connected",
        activeThreadBusy: true,
        queueCount: 0,
      }),
    ).toBe("Queue");
  });

  it("labels Queue when messages are already queued to send later", () => {
    expect(
      resolveComposerSendLabel({
        connectionState: "connected",
        activeThreadBusy: false,
        queueCount: 2,
      }),
    ).toBe("Queue");
  });

  it("labels Queue while the environment is not connected", () => {
    expect(
      resolveComposerSendLabel({
        connectionState: "reconnecting",
        activeThreadBusy: false,
        queueCount: 0,
      }),
    ).toBe("Queue");
  });
});
