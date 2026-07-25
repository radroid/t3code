import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAwarenessInputs,
  resolveActivationRouteParams,
  type AwarenessProjectInput,
  type AwarenessThreadInput,
} from "./coordinator.logic";

const NOW = "2026-07-25T12:00:00.000Z";

function thread(
  overrides: {
    readonly environmentId?: string;
    readonly projectId?: string;
    readonly id?: string;
  } = {},
): AwarenessThreadInput {
  return {
    environmentId: (overrides.environmentId ?? "env-1") as EnvironmentId,
    projectId: (overrides.projectId ?? "project-1") as ProjectId,
    id: (overrides.id ?? "thread-1") as ThreadId,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    session: null,
    latestTurn: null,
    updatedAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  };
}

function project(
  overrides: {
    readonly environmentId?: string;
    readonly id?: string;
    readonly title?: string;
  } = {},
): AwarenessProjectInput {
  return {
    environmentId: (overrides.environmentId ?? "env-1") as EnvironmentId,
    id: (overrides.id ?? "project-1") as ProjectId,
    title: overrides.title ?? "Proj",
  };
}

describe("buildAwarenessInputs", () => {
  it("pairs each thread with its project title", () => {
    const inputs = buildAwarenessInputs([thread()], [project({ title: "Checkout" })]);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.environmentId).toBe("env-1");
    expect(inputs[0]?.project.title).toBe("Checkout");
    expect(inputs[0]?.thread.id).toBe("thread-1");
  });

  it("falls back to an empty title when the project is unknown", () => {
    const inputs = buildAwarenessInputs([thread({ projectId: "missing" })], [project()]);

    expect(inputs[0]?.project.title).toBe("");
  });

  it("does not borrow a project title from another environment", () => {
    const inputs = buildAwarenessInputs(
      [thread({ environmentId: "env-2" })],
      [project({ environmentId: "env-1", title: "Checkout" })],
    );

    expect(inputs[0]?.project.title).toBe("");
  });

  it("keeps one input per environment-scoped thread so the tracker sees distinct keys", () => {
    const inputs = buildAwarenessInputs(
      [thread(), thread(), thread({ environmentId: "env-2" }), thread({ id: "thread-2" })],
      [project(), project({ environmentId: "env-2", title: "Other" })],
    );

    expect(inputs.map((input) => `${input.environmentId}::${input.thread.id}`)).toEqual([
      "env-1::thread-1",
      "env-2::thread-1",
      "env-1::thread-2",
    ]);
  });
});

describe("resolveActivationRouteParams", () => {
  it("returns branded route params for a well-formed activation", () => {
    expect(resolveActivationRouteParams({ environmentId: "env-1", threadId: "thread-1" })).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
    });
  });

  it("rejects an activation missing either id", () => {
    expect(resolveActivationRouteParams({ environmentId: "", threadId: "thread-1" })).toBeNull();
    expect(resolveActivationRouteParams({ environmentId: "env-1", threadId: "" })).toBeNull();
  });
});
