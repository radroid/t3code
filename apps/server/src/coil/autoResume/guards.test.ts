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
  /** ISO time the latest turn ended; drives the "did it outlive the closed window?" rule. */
  latestTurnCompletedAt?: string | null;
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
        ? {
            turnId: o.latestTurnId ?? "turn-1",
            state: o.latestTurnState ?? "completed",
            completedAt: o.latestTurnCompletedAt ?? null,
          }
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

  // The arm the guard re-checks: the baseline PLUS the window it is waiting on. Written
  // at test-clock scale (epoch ms, not wall-clock 2026 dates) on purpose — `resumeAtMs`
  // comes from `Clock.currentTimeMillis`, which is 0-based under TestClock, so a fixture
  // that mixes real ISO turn times with a test-clock arm reads every turn as post-window.
  const REOPENS_AT_MS = 1_000;
  const AFTER_REOPEN_ISO = "1970-01-01T00:00:06.000Z"; // 6_000ms — after the window opened
  const BEFORE_REOPEN_ISO = "1970-01-01T00:00:00.500Z"; // 500ms — inside the shut window
  const arm = () => ({ baseline: baseline(), resumeAtMs: REOPENS_AT_MS });

  it("returns null when nothing changed and thread is idle Claude", () => {
    expect(cancelReason(base(), arm())).toBeNull();
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
    expect(cancelReason(thread, arm())).toBeNull();
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
    expect(cancelReason(thread, arm())).toBe("progressing");
  });

  // Still advancement — but it now needs the turn to have OUTLIVED the closed window.
  // A turn that lived entirely inside it is the doomed-turn case, covered below.
  it("detects a new turn since scheduling", () => {
    const thread = makeThread({
      messages: [{ id: "u1", role: "user" }],
      latestTurnId: "turn-2",
      latestTurnCompletedAt: AFTER_REOPEN_ISO,
    });
    expect(cancelReason(thread, arm())).toBe("thread-advanced");
  });

  // Regression for radroid/t3code#6: a limit captured mid-turn pins the running turn's id
  // in the baseline, and the snapshot can report `latestTurn: null` at fire time when the
  // join finds no retained turn row. Null is "no turn to report", not advancement —
  // cancelling here killed every real-world resume.
  it("does NOT treat a settled-away turn (latestTurn null at fire) as advancement", () => {
    const thread = makeThread({
      messages: [{ id: "u1", role: "user" }],
      status: "stopped",
    });
    expect(thread.latestTurn).toBeNull();
    expect(cancelReason(thread, arm())).toBeNull();
  });

  it("still detects advancement when a turn exists but the baseline had none", () => {
    const noTurnArm = {
      baseline: captureBaseline(makeThread({ messages: [{ id: "u1", role: "user" }] })),
      resumeAtMs: REOPENS_AT_MS,
    };
    const thread = makeThread({
      messages: [{ id: "u1", role: "user" }],
      latestTurnId: "turn-9",
      latestTurnCompletedAt: AFTER_REOPEN_ISO,
    });
    expect(cancelReason(thread, noTurnArm)).toBe("thread-advanced");
  });

  // --- the 2026-08-18 doomed-turn rule -------------------------------------------------
  // These three drive the real timestamp arithmetic. They are not optional garnish: the
  // locked replay fixture leaves `completedAt` unset, so it reaches the right verdict via
  // the no-evidence fallback and would stay green even if this comparison were inverted.
  // In production `completed_at` is always present (0 of 764 settled turns are null), so
  // the comparison below is the only thing standing between us and a fourth incident.

  it("does NOT treat a turn that lived inside the shut window as advancement", () => {
    const thread = makeThread({
      messages: [{ id: "u1", role: "user" }],
      latestTurnId: "turn-doomed",
      latestTurnCompletedAt: BEFORE_REOPEN_ISO,
    });
    expect(cancelReason(thread, arm())).toBeNull();
  });

  // The incident's own arithmetic, at wall-clock scale: turn 64f7c4b7 ran 19:34:44.276 ->
  // 19:34:44.784 against a five_hour window whose arm was due at 19:51:00. The sibling
  // threads that DID resume started their next turns at 19:51:42 — after the reopen.
  it("separates the incident's doomed turn from the siblings' real ones", () => {
    const incidentArm = {
      baseline: captureBaseline(
        makeThread({ messages: [{ id: "u1", role: "user" }], latestTurnId: "turn-f0d77468" }),
      ),
      resumeAtMs: Date.parse("2026-08-18T19:51:00.000Z"),
    };
    const doomed = makeThread({
      messages: [{ id: "u1", role: "user" }],
      latestTurnId: "turn-64f7c4b7",
      latestTurnCompletedAt: "2026-08-18T19:34:44.784Z",
    });
    expect(cancelReason(doomed, incidentArm)).toBeNull();

    const genuine = makeThread({
      messages: [{ id: "u1", role: "user" }],
      latestTurnId: "turn-after-reopen",
      latestTurnCompletedAt: "2026-08-18T19:52:10.000Z",
    });
    expect(cancelReason(genuine, incidentArm)).toBe("thread-advanced");
  });

  // Absent timing evidence is NOT evidence of advancement — cancelling is the destructive
  // move, so "no proof" must never cancel. Stated as an invariant rather than left as an
  // accident of a null check.
  it("does NOT cancel for a turn it cannot place in time", () => {
    const noTimestamp = makeThread({
      messages: [{ id: "u1", role: "user" }],
      latestTurnId: "turn-unknown",
    });
    expect(cancelReason(noTimestamp, arm())).toBeNull();

    const unparseable = makeThread({
      messages: [{ id: "u1", role: "user" }],
      latestTurnId: "turn-unknown",
      latestTurnCompletedAt: "not-a-timestamp",
    });
    expect(cancelReason(unparseable, arm())).toBeNull();
  });

  it("blocks when awaiting input", () => {
    const thread = makeThread({
      messages: [{ id: "u1", role: "user" }],
      latestTurnId: "turn-1",
      activities: [{ kind: "approval.requested", payload: { requestId: "r1" } }],
    });
    expect(cancelReason(thread, arm())).toBe("awaiting-input");
  });

  it("prioritizes thread-gone and non-claude and progressing", () => {
    expect(cancelReason(makeThread({ deletedAt: "x" }), arm())).toBe("thread-gone");
    expect(cancelReason(makeThread({ providerName: "codex" }), arm())).toBe("not-claude");
    expect(cancelReason(makeThread({ status: "running" }), arm())).toBe("progressing");
  });
});
