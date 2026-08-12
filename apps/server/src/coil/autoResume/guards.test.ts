import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThread } from "@t3tools/contracts";

import {
  cancelReason,
  captureBaseline,
  hasOpenBlockingRequest,
  isClaudeThread,
  newestUserMessageId,
  threadIsGone,
  threadIsProgressing,
} from "./guards.ts";

type Msg = { id: string; role: string };
type Act = { kind: string; payload: unknown };

// Minimal thread shape covering only the fields the guards read.
const makeThread = (o: {
  messages?: Msg[];
  activities?: Act[];
  status?: string;
  providerName?: string | null;
  latestTurnState?: string | null;
  latestTurnId?: string | null;
  deletedAt?: string | null;
  archivedAt?: string | null;
  settledOverride?: string | null;
}): OrchestrationThread =>
  ({
    id: "thread-1",
    projectId: "project-1",
    messages: o.messages ?? [],
    activities: o.activities ?? [],
    deletedAt: o.deletedAt ?? null,
    archivedAt: o.archivedAt ?? null,
    settledOverride: o.settledOverride ?? null,
    latestTurn:
      o.latestTurnId || o.latestTurnState
        ? { turnId: o.latestTurnId ?? "turn-1", state: o.latestTurnState ?? "completed" }
        : null,
    session: {
      status: o.status ?? "ready",
      providerName: o.providerName === undefined ? "claudeAgent" : o.providerName,
    },
  }) as unknown as OrchestrationThread;

describe("newestUserMessageId", () => {
  it("returns the last user message id, ignoring assistant messages", () => {
    const thread = makeThread({
      messages: [
        { id: "m1", role: "user" },
        { id: "m2", role: "assistant" },
        { id: "m3", role: "user" },
        { id: "m4", role: "assistant" },
      ],
    });
    expect(newestUserMessageId(thread)).toBe("m3");
  });

  it("returns null with no user messages", () => {
    expect(
      newestUserMessageId(makeThread({ messages: [{ id: "m1", role: "assistant" }] })),
    ).toBeNull();
  });
});

describe("hasOpenBlockingRequest", () => {
  it("is true for an unresolved approval request", () => {
    expect(
      hasOpenBlockingRequest([{ kind: "approval.requested", payload: { requestId: "r1" } }]),
    ).toBe(true);
  });

  it("is false once the request is resolved", () => {
    expect(
      hasOpenBlockingRequest([
        { kind: "approval.requested", payload: { requestId: "r1" } },
        { kind: "approval.resolved", payload: { requestId: "r1" } },
      ]),
    ).toBe(false);
  });

  it("clears on a stale respond-failed detail", () => {
    expect(
      hasOpenBlockingRequest([
        { kind: "user-input.requested", payload: { requestId: "r1" } },
        {
          kind: "provider.user-input.respond.failed",
          payload: { requestId: "r1", detail: "Unknown pending user-input request" },
        },
      ]),
    ).toBe(false);
  });

  it("stays open on a non-stale respond-failed detail", () => {
    expect(
      hasOpenBlockingRequest([
        { kind: "user-input.requested", payload: { requestId: "r1" } },
        {
          kind: "provider.user-input.respond.failed",
          payload: { requestId: "r1", detail: "boom" },
        },
      ]),
    ).toBe(true);
  });

  it("ignores activities without a requestId", () => {
    expect(hasOpenBlockingRequest([{ kind: "approval.requested", payload: {} }])).toBe(false);
  });
});

describe("simple predicates", () => {
  it("isClaudeThread matches the claudeAgent driver, case-insensitively", () => {
    expect(isClaudeThread(makeThread({ providerName: "claudeAgent" }))).toBe(true);
    expect(isClaudeThread(makeThread({ providerName: "ClaudeAgent" }))).toBe(true);
    expect(isClaudeThread(makeThread({ providerName: "codex" }))).toBe(false);
    expect(isClaudeThread(makeThread({ providerName: null }))).toBe(false);
  });

  it("threadIsGone covers deleted / archived / settled", () => {
    expect(threadIsGone(makeThread({ deletedAt: "2026-01-01" }))).toBe(true);
    expect(threadIsGone(makeThread({ archivedAt: "2026-01-01" }))).toBe(true);
    expect(threadIsGone(makeThread({ settledOverride: "settled" }))).toBe(true);
    expect(threadIsGone(makeThread({}))).toBe(false);
  });

  it("threadIsProgressing covers running/starting session and running turn", () => {
    expect(threadIsProgressing(makeThread({ status: "running" }))).toBe(true);
    expect(threadIsProgressing(makeThread({ status: "starting" }))).toBe(true);
    expect(threadIsProgressing(makeThread({ status: "ready", latestTurnState: "running" }))).toBe(
      true,
    );
    expect(threadIsProgressing(makeThread({ status: "ready", latestTurnState: "completed" }))).toBe(
      false,
    );
  });

  // Crash-recovery reconciliation settles leftover in-flight turns to a resumable
  // `interrupted` state with a `stopped` session (see CrashRecoveryReconciler). Such a
  // thread must NOT read as progressing, otherwise auto-resume would treat the crashed
  // turn as still-working and never resume it.
  it("threadIsProgressing is false for a reconciled interrupted/stopped thread", () => {
    expect(
      threadIsProgressing(makeThread({ status: "stopped", latestTurnState: "interrupted" })),
    ).toBe(false);
  });
});

describe("cancelReason", () => {
  const base = () =>
    makeThread({
      messages: [{ id: "u1", role: "user" }],
      latestTurnId: "turn-1",
      latestTurnState: "completed",
      status: "ready",
    });
  const baseline = () => captureBaseline(base());

  it("returns null when nothing changed and thread is idle Claude", () => {
    expect(cancelReason(base(), baseline())).toBeNull();
  });

  // Regression for radroid/t3code#39. The removed `user-took-over` branch cancelled on
  // any newer user message. The message that trips it is typically "keep going" typed at
  // the usage-limit banner — and is itself rejected by the same limit, so it starts
  // nothing and the thread is left with no pending resume at all.
  it("does NOT cancel when a new user message arrived while the resume was pending", () => {
    const thread = makeThread({
      messages: [
        { id: "u1", role: "user" },
        { id: "u2", role: "user" },
      ],
      latestTurnId: "turn-1",
    });
    expect(cancelReason(thread, baseline())).toBeNull();
  });

  // The baseline still records it — it is persisted with the pending resume and is what
  // makes a stranded arm diagnosable from the state file.
  it("still captures the newest user message id in the baseline", () => {
    expect(baseline().newestUserMessageId).toBe("u1");
  });

  // What the removed branch was actually reaching for: a user who is driving right now.
  // That is `progressing`, and it still cancels.
  it("cancels a new user message that is actually being worked on", () => {
    const thread = makeThread({
      messages: [
        { id: "u1", role: "user" },
        { id: "u2", role: "user" },
      ],
      status: "running",
    });
    expect(cancelReason(thread, baseline())).toBe("progressing");
  });

  it("detects a new turn since scheduling", () => {
    const thread = makeThread({ messages: [{ id: "u1", role: "user" }], latestTurnId: "turn-2" });
    expect(cancelReason(thread, baseline())).toBe("thread-advanced");
  });

  // Regression for radroid/t3code#6: the projection populates latest_turn_id only while
  // a turn is active, so a limit captured mid-turn (baseline has the running turn's id)
  // always sees latestTurn: null once that turn settles. Null is "no active turn", not
  // advancement — cancelling here killed every real-world resume.
  it("does NOT treat a settled-away turn (latestTurn null at fire) as advancement", () => {
    const thread = makeThread({
      messages: [{ id: "u1", role: "user" }],
      status: "stopped",
    });
    expect(thread.latestTurn).toBeNull();
    expect(cancelReason(thread, baseline())).toBeNull();
  });

  it("still detects advancement when a turn exists but the baseline had none", () => {
    const noTurnBaseline = captureBaseline(makeThread({ messages: [{ id: "u1", role: "user" }] }));
    const thread = makeThread({ messages: [{ id: "u1", role: "user" }], latestTurnId: "turn-9" });
    expect(cancelReason(thread, noTurnBaseline)).toBe("thread-advanced");
  });

  it("blocks when awaiting input", () => {
    const thread = makeThread({
      messages: [{ id: "u1", role: "user" }],
      latestTurnId: "turn-1",
      activities: [{ kind: "approval.requested", payload: { requestId: "r1" } }],
    });
    expect(cancelReason(thread, baseline())).toBe("awaiting-input");
  });

  it("prioritizes thread-gone and non-claude and progressing", () => {
    expect(cancelReason(makeThread({ deletedAt: "x" }), baseline())).toBe("thread-gone");
    expect(cancelReason(makeThread({ providerName: "codex" }), baseline())).toBe("not-claude");
    expect(cancelReason(makeThread({ status: "running" }), baseline())).toBe("progressing");
  });
});
