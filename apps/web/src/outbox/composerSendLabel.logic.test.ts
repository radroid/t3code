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

  it("labels Queue while the active thread is busy and cannot be steered", () => {
    expect(
      resolveComposerSendLabel({
        connectionState: "connected",
        activeThreadBusy: true,
        queueCount: 0,
      }),
    ).toBe("Queue");
    expect(
      resolveComposerSendLabel({
        connectionState: "connected",
        activeThreadBusy: true,
        queueCount: 0,
        canSteerActiveThread: false,
      }),
    ).toBe("Queue");
  });

  it("labels Send into a running turn the provider can steer", () => {
    expect(
      resolveComposerSendLabel({
        connectionState: "connected",
        activeThreadBusy: true,
        queueCount: 0,
        canSteerActiveThread: true,
      }),
    ).toBe("Send");
  });

  it("still queues a steerable thread when the outbox already holds messages", () => {
    // Steering would deliver this message ahead of ones queued before it.
    expect(
      resolveComposerSendLabel({
        connectionState: "connected",
        activeThreadBusy: true,
        queueCount: 1,
        canSteerActiveThread: true,
      }),
    ).toBe("Queue");
  });

  it("never steers while disconnected, however capable the provider is", () => {
    expect(
      resolveComposerSendLabel({
        connectionState: "reconnecting",
        activeThreadBusy: true,
        queueCount: 0,
        canSteerActiveThread: true,
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
