import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import { describe, expect, it } from "vite-plus/test";

import {
  attentionKey,
  attentionKindForEdge,
  buildAttentionPayload,
  createAttentionEdgeTracker,
} from "./attention.ts";

describe("attentionKindForEdge", () => {
  it("announces waiting phases on entry regardless of the previous phase", () => {
    expect(attentionKindForEdge("running", "waiting_for_approval")).toBe("waiting_for_approval");
    expect(attentionKindForEdge("completed", "waiting_for_input")).toBe("waiting_for_input");
  });

  it("announces completed only out of running", () => {
    expect(attentionKindForEdge("running", "completed")).toBe("completed");
    expect(attentionKindForEdge("starting", "completed")).toBeNull();
    expect(attentionKindForEdge(null, "completed")).toBeNull();
  });

  it("stays silent for non-attention phases", () => {
    expect(attentionKindForEdge("waiting_for_input", "running")).toBeNull();
    expect(attentionKindForEdge("running", "starting")).toBeNull();
    expect(attentionKindForEdge("running", "failed")).toBeNull();
    expect(attentionKindForEdge("running", "stale")).toBeNull();
  });
});

describe("createAttentionEdgeTracker", () => {
  it("never fires on a thread's first observation", () => {
    const tracker = createAttentionEdgeTracker();
    expect(tracker.observe("t1", "waiting_for_input")).toBeNull();
  });

  it("fires completed only on running -> completed", () => {
    const tracker = createAttentionEdgeTracker();
    expect(tracker.observe("t1", "running")).toBeNull(); // first-seen
    expect(tracker.observe("t1", "completed")).toBe("completed");
  });

  it("does not fire completed when the thread was never seen running", () => {
    const tracker = createAttentionEdgeTracker();
    expect(tracker.observe("t1", "starting")).toBeNull(); // first-seen
    expect(tracker.observe("t1", "completed")).toBeNull(); // starting -> completed
  });

  it("fires waiting_for_input on entry after a prior observation", () => {
    const tracker = createAttentionEdgeTracker();
    expect(tracker.observe("t1", "running")).toBeNull();
    expect(tracker.observe("t1", "waiting_for_input")).toBe("waiting_for_input");
  });

  it("does not re-fire while the phase is unchanged", () => {
    const tracker = createAttentionEdgeTracker();
    tracker.observe("t1", "running");
    expect(tracker.observe("t1", "waiting_for_approval")).toBe("waiting_for_approval");
    expect(tracker.observe("t1", "waiting_for_approval")).toBeNull();
  });

  it("treats a null phase as an observation that never fires", () => {
    const tracker = createAttentionEdgeTracker();
    tracker.observe("t1", "running");
    expect(tracker.observe("t1", null)).toBeNull();
    // Coming back to completed from a null observation is not a running->completed edge.
    expect(tracker.observe("t1", "completed")).toBeNull();
  });

  it("tracks threads independently", () => {
    const tracker = createAttentionEdgeTracker();
    tracker.observe("t1", "running");
    expect(tracker.observe("t2", "completed")).toBeNull(); // t2 first-seen
    expect(tracker.observe("t1", "completed")).toBe("completed");
  });

  it("re-arms first-seen after forget", () => {
    const tracker = createAttentionEdgeTracker();
    tracker.observe("t1", "running");
    tracker.forget("t1");
    // First observation again -> no fire even though it's a completed value.
    expect(tracker.observe("t1", "completed")).toBeNull();
  });
});

describe("buildAttentionPayload", () => {
  it("maps an awareness state + edge into the service-worker payload", () => {
    const state = {
      environmentId: "env-1",
      threadId: "thread-1",
      projectTitle: "My Project",
      threadTitle: "Fix the bug",
      phase: "waiting_for_input",
      headline: "Waiting for input",
      modelTitle: "claude",
      updatedAt: "2026-07-27T00:00:00.000Z",
      deepLink: "/threads/env-1/thread-1",
    } as unknown as AgentAwarenessState;

    expect(buildAttentionPayload(state, "waiting_for_input")).toEqual({
      title: "Waiting for input",
      body: "My Project · Fix the bug",
      key: "env-1::thread-1",
      environmentId: "env-1",
      threadId: "thread-1",
      kind: "waiting_for_input",
    });
  });

  it("keys by environment + thread", () => {
    expect(attentionKey("env-1", "thread-1")).toBe("env-1::thread-1");
  });
});
