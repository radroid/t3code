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

  it("detects a new user message", () => {
    const thread = makeThread({
      messages: [
        { id: "u1", role: "user" },
        { id: "u2", role: "user" },
      ],
      latestTurnId: "turn-1",
    });
    expect(cancelReason(thread, baseline())).toBe("user-took-over");
  });

  it("detects a new turn since scheduling", () => {
    const thread = makeThread({ messages: [{ id: "u1", role: "user" }], latestTurnId: "turn-2" });
    expect(cancelReason(thread, baseline())).toBe("thread-advanced");
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
