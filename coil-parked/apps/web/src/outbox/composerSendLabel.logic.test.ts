import { describe, expect, it } from "vite-plus/test";

import { resolveComposerSendLabel } from "./composerSendLabel.logic";

describe("resolveComposerSendLabel", () => {
  it("labels Send when connected and the outbox is empty", () => {
    expect(resolveComposerSendLabel({ connectionState: "connected", queueCount: 0 })).toBe("Send");
  });

  it("labels Queue when messages are already queued to send later", () => {
    expect(resolveComposerSendLabel({ connectionState: "connected", queueCount: 2 })).toBe("Queue");
  });

  it("labels Queue while the environment is not connected", () => {
    expect(resolveComposerSendLabel({ connectionState: "reconnecting", queueCount: 0 })).toBe(
      "Queue",
    );
  });
});
