import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { ProjectThreadAwarenessInput } from "@t3tools/shared/agentAwareness";

import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { attentionKey } from "./needsAttention.logic";

/** The slice of an `EnvironmentThreadShell` the awareness ladder reads. */
export type AwarenessThreadInput = ProjectThreadAwarenessInput["thread"] & {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
};

/** The slice of an `EnvironmentProject` needed to title a thread's project. */
export interface AwarenessProjectInput {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly title: string;
}

function projectKey(environmentId: EnvironmentId, projectId: ProjectId): string {
  return `${environmentId}::${projectId}`;
}

/**
 * Pairs every thread shell with its project title for the attention tracker.
 *
 * Project titles are looked up per environment, never by bare project id: two
 * environments can hand out the same id for unrelated projects. Threads are
 * deduped by environment-scoped key because the tracker treats a repeated key
 * within one update as two independent observations.
 */
export function buildAwarenessInputs(
  threads: ReadonlyArray<AwarenessThreadInput>,
  projects: ReadonlyArray<AwarenessProjectInput>,
): ReadonlyArray<ProjectThreadAwarenessInput> {
  const titles = new Map<string, string>();
  for (const project of projects) {
    titles.set(projectKey(project.environmentId, project.id), project.title);
  }

  const seen = new Set<string>();
  const inputs: ProjectThreadAwarenessInput[] = [];
  for (const thread of threads) {
    const key = attentionKey(thread.environmentId, thread.id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    inputs.push({
      environmentId: thread.environmentId,
      project: { title: titles.get(projectKey(thread.environmentId, thread.projectId)) ?? "" },
      thread,
    });
  }
  return inputs;
}

/**
 * Turns a notification activation's plain string ids into thread route params.
 * The ids cross an IPC (or notification-click) boundary untyped, so a malformed
 * payload resolves to null rather than navigating to a nonexistent route.
 */
export function resolveActivationRouteParams(activation: {
  readonly environmentId: string;
  readonly threadId: string;
}): { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null {
  const ref = resolveThreadRouteRef(activation);
  return ref === null ? null : buildThreadRouteParams(ref);
}
