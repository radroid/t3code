// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodePath from "node:path";

import {
  type CheckInPromptInput,
  composeCheckInPrompt,
  DEFERENCE_LINE,
  LOOP_DONE_RELATIVE_PATH,
  LOOP_PROMPT_RELATIVE_PATH,
  resolveConfig,
  resolveLoopRoots,
  wakeGraceMs,
} from "./config.ts";

describe("resolveConfig", () => {
  it("119 — an empty env yields the documented defaults", () => {
    const config = resolveConfig({});
    // The kill switch defaults ON: the fiber exists, and the thing that stops loops firing
    // is `global.enabled` in the durable store, which defaults OFF.
    assert.strictEqual(config.enabled, true);
    assert.strictEqual(config.pollMs, 60_000);
    assert.strictEqual(config.idleMs, 15 * 60_000);
    assert.strictEqual(config.busyIdleMs, 45 * 60_000);
    assert.strictEqual(config.productiveMs, 2 * 60_000);
    assert.strictEqual(config.wakeGraceMinMs, 90_000);
    assert.strictEqual(config.wakeGraceMaxMs, 15 * 60_000);
    assert.strictEqual(config.wakeGraceFraction, 0.1);
  });

  it("119 — COIL_LOOP_* overrides are parsed and invalid values fall back", () => {
    const config = resolveConfig({
      COIL_LOOP_ENABLED: "off",
      COIL_LOOP_POLL_MS: "15000",
      COIL_LOOP_IDLE_MS: "0", // invalid -> default
      COIL_LOOP_BUSY_IDLE_MS: "-1", // invalid -> default
      COIL_LOOP_PRODUCTIVE_MS: "30000",
      COIL_LOOP_WAKE_GRACE_FRACTION: "0.25",
    });
    assert.strictEqual(config.enabled, false);
    assert.strictEqual(config.pollMs, 15_000);
    assert.strictEqual(config.idleMs, 15 * 60_000);
    assert.strictEqual(config.busyIdleMs, 45 * 60_000);
    assert.strictEqual(config.productiveMs, 30_000);
    assert.strictEqual(config.wakeGraceFraction, 0.25);
  });

  it("119 — a nonsense grace fraction falls back rather than disabling deference", () => {
    assert.strictEqual(
      resolveConfig({ COIL_LOOP_WAKE_GRACE_FRACTION: "9" }).wakeGraceFraction,
      0.1,
    );
    assert.strictEqual(
      resolveConfig({ COIL_LOOP_WAKE_GRACE_FRACTION: "0" }).wakeGraceFraction,
      0.1,
    );
    assert.strictEqual(
      resolveConfig({ COIL_LOOP_WAKE_GRACE_FRACTION: "nope" }).wakeGraceFraction,
      0.1,
    );
  });

  it("119 — the T3X_* names of the neighbouring features are not inherited", () => {
    const config = resolveConfig({ T3X_LOOP_ENABLED: "false", T3X_AUTO_RESUME_POLL_MS: "1" });
    assert.strictEqual(config.enabled, true);
    assert.strictEqual(config.pollMs, 60_000);
  });
});

describe("wakeGraceMs", () => {
  const config = resolveConfig({});

  it("119 — a one-shot wake gets the flat floor", () => {
    assert.strictEqual(wakeGraceMs({ recurring: false, periodMs: 30 * 60_000 }, config), 90_000);
  });

  it("119 — a recurring wake's grace scales with its period", () => {
    // 10% of 30 minutes is 3 minutes, comfortably above the floor and below the cap.
    assert.strictEqual(wakeGraceMs({ recurring: true, periodMs: 30 * 60_000 }, config), 180_000);
  });

  it("119 — a short period never drops below the floor", () => {
    // 10% of 5 minutes is 30s; a flat-90s reading is the FLOOR, not the whole rule.
    assert.strictEqual(wakeGraceMs({ recurring: true, periodMs: 5 * 60_000 }, config), 90_000);
  });

  it("119 — a long period is capped, so a weekly wake is not deferred to for a day", () => {
    assert.strictEqual(
      wakeGraceMs({ recurring: true, periodMs: 7 * 24 * 3_600_000 }, config),
      15 * 60_000,
    );
  });

  it("119 — an unknown period falls back to the floor rather than deferring forever", () => {
    assert.strictEqual(wakeGraceMs({ recurring: true, periodMs: null }, config), 90_000);
    assert.strictEqual(wakeGraceMs({ recurring: true, periodMs: 0 }, config), 90_000);
  });
});

describe("resolveLoopRoots", () => {
  it("120 — the worktree comes first, because that is the agent's real cwd", () => {
    assert.deepStrictEqual(
      [...resolveLoopRoots({ worktreePath: "/wt", workspaceRoot: "/repo" })],
      ["/wt", "/repo"],
    );
  });

  it("120 — a thread with no worktree falls back to the workspace root", () => {
    assert.deepStrictEqual(
      [...resolveLoopRoots({ worktreePath: null, workspaceRoot: "/repo" })],
      ["/repo"],
    );
  });

  it("120 — identical roots are not stat-ed twice", () => {
    assert.deepStrictEqual(
      [...resolveLoopRoots({ worktreePath: "/repo", workspaceRoot: "/repo" })],
      ["/repo"],
    );
  });
});

const baseInput = (overrides: Partial<CheckInPromptInput> = {}): CheckInPromptInput => ({
  worktreePath: null,
  workspaceRoot: null,
  overridePrompt: null,
  checkInNumber: 2,
  maxCheckIns: 6,
  deadlineAtMs: Date.parse("2026-09-02T07:00:00.000Z"),
  nowMs: Date.parse("2026-09-02T01:00:00.000Z"),
  goal: null,
  bankedAnswers: [],
  ...overrides,
});

const compose = (input: CheckInPromptInput) =>
  composeCheckInPrompt(input).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

const withRoot = <A, E>(
  f: (root: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "coil-loop-prompt-" });
    return yield* f(root);
  }).pipe(Effect.scoped, Effect.orDie, Effect.provide(NodeServices.layer), Effect.runPromise);

const writePromptFile = (root: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const promptPath = NodePath.join(root, LOOP_PROMPT_RELATIVE_PATH);
    yield* fs.makeDirectory(NodePath.dirname(promptPath), { recursive: true });
    yield* fs.writeFileString(promptPath, contents);
  });

describe("composeCheckInPrompt", () => {
  it("119 — a per-thread override wins over everything", async () => {
    const prompt = await withRoot((root) =>
      Effect.gen(function* () {
        yield* writePromptFile(root, "from the project file");
        return yield* composeCheckInPrompt(
          baseInput({ workspaceRoot: root, overridePrompt: "  from the override  " }),
        );
      }),
    );
    assert.strictEqual(prompt.source, "override");
    assert.ok(prompt.text.includes("from the override"));
    assert.ok(!prompt.text.includes("from the project file"));
  });

  it("119 — the project file wins over the built-in", async () => {
    const prompt = await withRoot((root) =>
      Effect.gen(function* () {
        yield* writePromptFile(root, "read the latest iter log and continue\n");
        return yield* composeCheckInPrompt(baseInput({ workspaceRoot: root }));
      }),
    );
    assert.strictEqual(prompt.source, "project-file");
    assert.ok(prompt.text.includes("read the latest iter log and continue"));
  });

  it("119 — the built-in is used when there is neither", async () => {
    const prompt = await compose(baseInput());
    assert.strictEqual(prompt.source, "built-in");
  });

  it("119 — the worktree's prompt file wins over the workspace root's", async () => {
    const prompt = await withRoot((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const worktree = NodePath.join(root, "wt");
        const workspace = NodePath.join(root, "repo");
        yield* fs.makeDirectory(worktree, { recursive: true });
        yield* fs.makeDirectory(workspace, { recursive: true });
        yield* writePromptFile(worktree, "worktree body");
        yield* writePromptFile(workspace, "workspace body");
        return yield* composeCheckInPrompt(
          baseInput({ worktreePath: worktree, workspaceRoot: workspace }),
        );
      }),
    );
    assert.ok(prompt.text.includes("worktree body"));
    assert.ok(!prompt.text.includes("workspace body"));
  });

  it("120 — the done-file path is absolute and rooted at the worktree", async () => {
    const prompt = await compose(
      baseInput({ worktreePath: "/tmp/wt", workspaceRoot: "/tmp/repo" }),
    );
    // The supervisor stats `worktreePath ?? workspaceRoot` first, so telling the agent the
    // workspace path would have it write the sentinel where nothing looks for it.
    assert.strictEqual(prompt.doneFilePath, NodePath.join("/tmp/wt", LOOP_DONE_RELATIVE_PATH));
    assert.ok(NodePath.isAbsolute(prompt.doneFilePath));
    assert.ok(prompt.text.includes(prompt.doneFilePath));
  });

  it("120 — a thread with no worktree gets the workspace root", async () => {
    const prompt = await compose(baseInput({ worktreePath: null, workspaceRoot: "/tmp/repo" }));
    assert.strictEqual(prompt.doneFilePath, NodePath.join("/tmp/repo", LOOP_DONE_RELATIVE_PATH));
  });

  it("121 — the check-in number and budget are interpolated at every position", async () => {
    for (let n = 1; n <= 6; n++) {
      const prompt = await compose(baseInput({ checkInNumber: n, maxCheckIns: 6 }));
      assert.ok(
        prompt.text.includes(`check-in ${n} of 6`),
        `check-in ${n} of 6 missing from: ${prompt.text.slice(0, 60)}`,
      );
    }
  });

  it("121 — the deadline is stated, with the time remaining", async () => {
    const prompt = await compose(baseInput());
    assert.ok(prompt.text.includes("2026-09-02T07:00:00.000Z"));
    assert.ok(prompt.text.includes("6h 0m left"));
  });

  it("121 — the do-not-restart instruction is restated in full every time", async () => {
    // A six-check-in overnight run compacts; a contract taught once is gone by check-in four.
    for (const input of [
      baseInput(),
      baseInput({ overridePrompt: "custom" }),
      baseInput({ goal: "land the sync" }),
    ]) {
      const prompt = await compose(input);
      assert.ok(prompt.text.includes("Do not restart from the top"));
    }
  });

  it("122 — answered-but-undelivered blockers are included and reported for marking", async () => {
    const prompt = await compose(
      baseInput({
        bankedAnswers: [
          { id: "b-1", question: "Migration or shim?", answer: "shim" },
          { id: "b-2", question: "Ship tonight?", answer: "hold" },
        ],
      }),
    );
    assert.ok(prompt.text.includes("Migration or shim?"));
    assert.ok(prompt.text.includes("shim"));
    assert.ok(prompt.text.includes("hold"));
    assert.deepStrictEqual([...prompt.deliveredBlockerIds], ["b-1", "b-2"]);
  });

  it("123 — only the blockers actually included are reported, so a later answer is not lost", async () => {
    // The caller flips `deliveredToAgent` for exactly these ids AFTER composing. A blocker
    // answered while the prompt was being built is simply not in the list, so it is carried
    // by the next check-in rather than being marked delivered and dropped.
    const prompt = await compose(
      baseInput({
        bankedAnswers: [
          { id: "b-1", question: "Migration or shim?", answer: "shim" },
          { id: "b-blank", question: "Not answered yet", answer: "   " },
        ],
      }),
    );
    assert.deepStrictEqual([...prompt.deliveredBlockerIds], ["b-1"]);
    assert.ok(!prompt.text.includes("Not answered yet"));
  });

  it("122 — no banked answers means no answers section and nothing to mark", async () => {
    const prompt = await compose(baseInput());
    assert.ok(!prompt.text.includes("Answers to questions you raised"));
    assert.deepStrictEqual([...prompt.deliveredBlockerIds], []);
  });

  it("124 — the prompt never begins with `/`, whatever the body is", async () => {
    const prompts = await Promise.all([
      compose(baseInput()),
      compose(baseInput({ overridePrompt: "/compact and keep going" })),
      compose(baseInput({ goal: "/tmp is full" })),
    ]);
    for (const prompt of prompts) {
      assert.ok(!prompt.text.startsWith("/"), `would be read as a slash command: ${prompt.text}`);
    }

    const fromFile = await withRoot((root) =>
      Effect.gen(function* () {
        yield* writePromptFile(root, "/clear\nthen continue");
        return yield* composeCheckInPrompt(baseInput({ workspaceRoot: root }));
      }),
    );
    assert.ok(!fromFile.text.startsWith("/"));
  });

  it("125 — the deference line is present verbatim in every resolution path", async () => {
    const prompts = await Promise.all([
      compose(baseInput()),
      compose(baseInput({ overridePrompt: "custom body" })),
      compose(baseInput({ bankedAnswers: [{ id: "b-1", question: "q", answer: "a" }] })),
    ]);
    for (const prompt of prompts) {
      // Composing with the user's own self-pacing skill rather than claiming the schedule is
      // the whole reason the reactor can defer at all.
      assert.ok(prompt.text.includes(DEFERENCE_LINE), prompt.text);
    }

    const fromFile = await withRoot((root) =>
      Effect.gen(function* () {
        yield* writePromptFile(root, "project body");
        return yield* composeCheckInPrompt(baseInput({ workspaceRoot: root }));
      }),
    );
    assert.ok(fromFile.text.includes(DEFERENCE_LINE));
  });

  it("126 — an empty or whitespace prompt file falls through to the built-in", async () => {
    for (const contents of ["", "   \n\t\n"]) {
      const prompt = await withRoot((root) =>
        Effect.gen(function* () {
          yield* writePromptFile(root, contents);
          return yield* composeCheckInPrompt(baseInput({ workspaceRoot: root }));
        }),
      );
      assert.strictEqual(prompt.source, "built-in");
      assert.ok(prompt.text.includes(DEFERENCE_LINE));
    }
  });

  it("126 — an empty worktree prompt file falls through to the workspace root's", async () => {
    const prompt = await withRoot((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const worktree = NodePath.join(root, "wt");
        const workspace = NodePath.join(root, "repo");
        yield* fs.makeDirectory(worktree, { recursive: true });
        yield* fs.makeDirectory(workspace, { recursive: true });
        yield* writePromptFile(worktree, "\n\n");
        yield* writePromptFile(workspace, "workspace body");
        return yield* composeCheckInPrompt(
          baseInput({ worktreePath: worktree, workspaceRoot: workspace }),
        );
      }),
    );
    assert.strictEqual(prompt.source, "project-file");
    assert.ok(prompt.text.includes("workspace body"));
  });

  it("127 — an unreadable prompt file falls through rather than failing the check-in", async () => {
    const prompt = await withRoot((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // A directory at the prompt path exists but cannot be read as a file (EISDIR).
        yield* fs.makeDirectory(NodePath.join(root, LOOP_PROMPT_RELATIVE_PATH), {
          recursive: true,
        });
        return yield* composeCheckInPrompt(baseInput({ workspaceRoot: root }));
      }),
    );
    assert.strictEqual(prompt.source, "built-in");
    assert.ok(prompt.text.includes(DEFERENCE_LINE));
  });

  it("121 — the goal is carried when there is one, and omitted when there is not", async () => {
    const withGoal = await compose(baseInput({ goal: "  land the sync  " }));
    assert.ok(withGoal.text.includes("land the sync"));
    const withoutGoal = await compose(baseInput({ goal: "   " }));
    assert.ok(!withoutGoal.text.includes("The goal for this run"));
  });
});
