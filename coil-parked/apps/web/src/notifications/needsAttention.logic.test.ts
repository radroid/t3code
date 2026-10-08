import type { EnvironmentId, OrchestrationThreadShell, ThreadId, TurnId } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import type { ProjectThreadAwarenessInput } from "@t3tools/shared/agentAwareness";
import { describe, expect, it } from "vite-plus/test";

import {
  attentionKey,
  createAttentionTracker,
  shouldSuppressAttentionEvent,
  type AttentionViewState,
} from "./needsAttention.logic";

const NOW = "2026-07-25T12:00:00.000Z";

type ThreadShell = ProjectThreadAwarenessInput["thread"];
type SessionShell = NonNullable<OrchestrationThreadShell["session"]>;
type TurnShell = NonNullable<OrchestrationThreadShell["latestTurn"]>;

function session(overrides: Partial<SessionShell> = {}): SessionShell {
  return {
    threadId: "thread-1" as ThreadId,
    status: "running",
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId: "turn-1" as TurnId,
    lastError: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function turn(overrides: Partial<TurnShell> = {}): TurnShell {
  return {
    turnId: "turn-1" as TurnId,
    state: "running",
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: null,
    assistantMessageId: null,
    ...overrides,
  };
}

interface InputOverrides {
  readonly environmentId?: string;
  readonly projectTitle?: string;
  readonly thread?: Partial<ThreadShell>;
}

function makeInput(overrides: InputOverrides = {}): ProjectThreadAwarenessInput {
  return {
    environmentId: (overrides.environmentId ?? "env-1") as EnvironmentId,
    project: { title: overrides.projectTitle ?? "Proj" },
    thread: {
      id: "thread-1" as ThreadId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      session: session(),
      latestTurn: null,
      updatedAt: NOW,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      ...overrides.thread,
    },
  };
}

/** A thread the agent is actively working in. */
const running = () => makeInput();
/** A thread that is blocked on an approval decision. */
const awaitingApproval = () => makeInput({ thread: { hasPendingApprovals: true } });
/** A thread that is blocked on a user reply. */
const awaitingInput = () => makeInput({ thread: { hasPendingUserInput: true } });
/** A thread whose latest turn just finished. */
const finished = () =>
  makeInput({
    thread: {
      session: session({ status: "ready", activeTurnId: null }),
      latestTurn: turn({ state: "completed", completedAt: NOW }),
    },
  });
/** A freshly created thread: born at session status `ready`, no turn yet. */
const bornIdle = () =>
  makeInput({ thread: { session: session({ status: "ready", activeTurnId: null }) } });

describe("attentionKey", () => {
  it("scopes a thread id by its environment", () => {
    expect(attentionKey("env-1", "thread-1")).toBe("env-1::thread-1");
    expect(attentionKey("env-1", "thread-1")).not.toBe(attentionKey("env-2", "thread-1"));
  });
});

describe("createAttentionTracker", () => {
  it("never fires on the first observation of a thread already waiting for approval", () => {
    const tracker = createAttentionTracker();

    // The initial snapshot replays existing state; notifying here would spam
    // the user with everything that was already waiting when the app opened.
    expect(tracker.update([awaitingApproval()])).toEqual([]);
  });

  it("fires waiting_for_approval when a running thread starts waiting on an approval", () => {
    const tracker = createAttentionTracker();
    tracker.update([running()]);

    expect(tracker.update([awaitingApproval()])).toEqual([
      {
        key: "env-1::thread-1",
        kind: "waiting_for_approval",
        environmentId: "env-1",
        threadId: "thread-1",
        title: "Approval needed",
        body: "Proj · Thread",
      },
    ]);
  });

  it("fires waiting_for_input when a running thread starts waiting on a reply", () => {
    const tracker = createAttentionTracker();
    tracker.update([running()]);

    expect(tracker.update([awaitingInput()])).toEqual([
      {
        key: "env-1::thread-1",
        kind: "waiting_for_input",
        environmentId: "env-1",
        threadId: "thread-1",
        title: "Waiting for input",
        body: "Proj · Thread",
      },
    ]);
  });

  it("does not re-fire while the thread stays in the same phase", () => {
    const tracker = createAttentionTracker();
    tracker.update([running()]);
    tracker.update([awaitingApproval()]);

    // Unrelated fields churn on every upsert; only the phase edge matters.
    const reUpserted = makeInput({
      thread: { hasPendingApprovals: true, title: "Thread", updatedAt: "2026-07-25T12:00:05.000Z" },
    });
    expect(tracker.update([reUpserted])).toEqual([]);
    expect(tracker.update([awaitingApproval()])).toEqual([]);
  });

  it("fires again after an approval is resolved and a new one is requested", () => {
    const tracker = createAttentionTracker();
    tracker.update([running()]);
    tracker.update([awaitingApproval()]);

    expect(tracker.update([running()])).toEqual([]);

    const events = tracker.update([awaitingApproval()]);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("waiting_for_approval");
  });

  it("fires completed when a running thread finishes its turn", () => {
    const tracker = createAttentionTracker();
    tracker.update([running()]);

    expect(tracker.update([finished()])).toEqual([
      {
        key: "env-1::thread-1",
        kind: "completed",
        environmentId: "env-1",
        threadId: "thread-1",
        title: "Agent finished",
        body: "Proj · Thread",
      },
    ]);
  });

  it("does not fire completed for a freshly created thread that is born idle", () => {
    const tracker = createAttentionTracker();

    // Threads are born at session status `ready`, which the phase ladder
    // projects as `completed` — a spurious "Done" if we notified on it.
    expect(tracker.update([bornIdle()])).toEqual([]);
    expect(tracker.update([bornIdle()])).toEqual([]);
  });

  it("does not fire completed when the previous phase was not running", () => {
    const tracker = createAttentionTracker();
    tracker.update([running()]);
    tracker.update([awaitingInput()]);

    expect(tracker.update([finished()])).toEqual([]);
  });

  it("does not fire on transitions into starting, running, failed, or an unprojectable phase", () => {
    const tracker = createAttentionTracker();
    tracker.update([awaitingApproval()]);

    const starting = makeInput({ thread: { session: session({ status: "starting" }) } });
    expect(tracker.update([starting])).toEqual([]);
    expect(tracker.update([running()])).toEqual([]);

    const failed = makeInput({
      thread: { session: session({ status: "error", lastError: "Provider exited." }) },
    });
    expect(tracker.update([failed])).toEqual([]);

    // No session and no turn projects to null — nothing to notify about.
    const unknown = makeInput({ thread: { session: null } });
    expect(tracker.update([unknown])).toEqual([]);
  });

  it("fires when a thread leaves an unprojectable phase and starts waiting", () => {
    const tracker = createAttentionTracker();
    tracker.update([makeInput({ thread: { session: null } })]);

    const events = tracker.update([awaitingApproval()]);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("waiting_for_approval");
  });

  it("prunes threads missing from an update so a reappearing thread is first-seen again", () => {
    const tracker = createAttentionTracker();
    tracker.update([running()]);

    expect(tracker.update([])).toEqual([]);
    expect(tracker.update([awaitingApproval()])).toEqual([]);
    // Still tracked from the previous call, so the next edge fires normally.
    expect(tracker.update([running()])).toEqual([]);
    expect(tracker.update([awaitingApproval()])).toHaveLength(1);
  });

  it("tracks the same thread id in two environments independently", () => {
    const tracker = createAttentionTracker();
    const envA = { environmentId: "env-1" };
    const envB = { environmentId: "env-2", projectTitle: "Other" };
    tracker.update([makeInput(envA), makeInput(envB)]);

    const events = tracker.update([
      makeInput({ ...envA, thread: { hasPendingApprovals: true } }),
      makeInput(envB),
    ]);

    expect(events).toEqual([
      {
        key: "env-1::thread-1",
        kind: "waiting_for_approval",
        environmentId: "env-1",
        threadId: "thread-1",
        title: "Approval needed",
        body: "Proj · Thread",
      },
    ]);

    expect(
      tracker.update([makeInput(envA), makeInput({ ...envB, thread: finished().thread })]),
    ).toEqual([
      {
        key: "env-2::thread-1",
        kind: "completed",
        environmentId: "env-2",
        threadId: "thread-1",
        title: "Agent finished",
        body: "Other · Thread",
      },
    ]);
  });

  it("reports every thread that crossed an edge in the same update", () => {
    const tracker = createAttentionTracker();
    const threadB = { thread: { id: "thread-2" as ThreadId, title: "Second" } };
    tracker.update([makeInput(), makeInput(threadB)]);

    const events = tracker.update([
      makeInput({ thread: { hasPendingApprovals: true } }),
      makeInput({ thread: { ...threadB.thread, hasPendingUserInput: true } }),
    ]);

    expect(events.map((event) => [event.key, event.kind])).toEqual([
      ["env-1::thread-1", "waiting_for_approval"],
      ["env-1::thread-2", "waiting_for_input"],
    ]);
    expect(events[1]?.body).toBe("Proj · Second");
  });

  it("keeps separate trackers isolated from each other", () => {
    const first = createAttentionTracker();
    const second = createAttentionTracker();
    first.update([running()]);

    expect(second.update([awaitingApproval()])).toEqual([]);
    expect(first.update([awaitingApproval()])).toHaveLength(1);
  });
});

describe("shouldSuppressAttentionEvent", () => {
  const event = {
    key: "env-1::thread-1",
    kind: "waiting_for_approval",
    environmentId: "env-1",
    threadId: "thread-1",
    title: "Approval needed",
    body: "Proj · Thread",
  } as const;

  const focusedOnEvent: AttentionViewState = {
    hasFocus: true,
    visible: true,
    activeEnvironmentId: "env-1",
    activeThreadId: "thread-1",
  };

  it("suppresses only when the user is already looking at that chat", () => {
    expect(shouldSuppressAttentionEvent(event, focusedOnEvent)).toBe(true);
  });

  it("notifies when the window is blurred", () => {
    expect(shouldSuppressAttentionEvent(event, { ...focusedOnEvent, hasFocus: false })).toBe(false);
  });

  it("notifies when the tab is hidden", () => {
    expect(shouldSuppressAttentionEvent(event, { ...focusedOnEvent, visible: false })).toBe(false);
  });

  it("notifies when a different environment is on screen", () => {
    expect(
      shouldSuppressAttentionEvent(event, { ...focusedOnEvent, activeEnvironmentId: "env-2" }),
    ).toBe(false);
    expect(
      shouldSuppressAttentionEvent(event, { ...focusedOnEvent, activeEnvironmentId: null }),
    ).toBe(false);
  });

  it("notifies when a different chat is on screen", () => {
    expect(
      shouldSuppressAttentionEvent(event, { ...focusedOnEvent, activeThreadId: "thread-2" }),
    ).toBe(false);
    expect(shouldSuppressAttentionEvent(event, { ...focusedOnEvent, activeThreadId: null })).toBe(
      false,
    );
  });
});
