// Fixtures only: every transcript in here is written into a throwaway mkdtemp directory. The
// user's real ~/.claude is never touched, and nothing in this file reaches the network.

import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";

import {
  MACHINE_PROMPT_PREFIXES,
  isMachineSession,
  linkSessions,
  listSessionFiles,
  normalizePrompt,
  promptHash,
  readSessionFile,
  scanSessions,
} from "../lib/claudeCode.mjs";

const HERE = NodePath.dirname(new URL(import.meta.url).pathname);
const T3DB_PATH = NodePath.join(HERE, "..", "lib", "t3db.mjs");

const DAY = "2026-08-10";
const WINDOW = {
  start: Date.parse(`${DAY}T00:00:00.000Z`),
  end: Date.parse(`${DAY}T23:59:59.999Z`),
};

const tempDirs = [];

NodeTest.after(() => {
  for (const dir of tempDirs) {
    try {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp dir is not worth failing a suite over.
    }
  }
});

function makeTempDir() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worklog-"));
  tempDirs.push(dir);
  return dir;
}

/** Write records (objects, or raw strings for deliberately broken lines) as a .jsonl transcript. */
function writeTranscript(
  projectsDir,
  projectName,
  sessionId,
  records,
  { trailingNewline = true } = {},
) {
  const dir = NodePath.join(projectsDir, projectName);
  NodeFS.mkdirSync(dir, { recursive: true });
  const file = NodePath.join(dir, `${sessionId}.jsonl`);
  const body = records
    .map((record) => (typeof record === "string" ? record : JSON.stringify(record)))
    .join("\n");
  NodeFS.writeFileSync(file, trailingNewline ? `${body}\n` : body);
  return file;
}

const BASE = {
  cwd: "/Users/dev/Developer/demo",
  sessionId: "s-1",
  version: "2.1.226",
  gitBranch: "main",
  isSidechain: false,
};

function userPrompt(at, text, overrides = {}) {
  return {
    ...BASE,
    type: "user",
    uuid: `u-${at}`,
    timestamp: at,
    message: { role: "user", content: [{ type: "text", text }] },
    ...overrides,
  };
}

function userPromptString(at, text, overrides = {}) {
  return {
    ...BASE,
    type: "user",
    uuid: `us-${at}`,
    timestamp: at,
    message: { role: "user", content: text },
    ...overrides,
  };
}

function toolResult(at, overrides = {}) {
  return {
    ...BASE,
    type: "user",
    uuid: `tr-${at}`,
    timestamp: at,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    },
    ...overrides,
  };
}

function assistant(at, { model = "claude-opus-5", tool = false, ...overrides } = {}) {
  return {
    ...BASE,
    type: "assistant",
    uuid: `a-${at}`,
    timestamp: at,
    message: {
      role: "assistant",
      model,
      content: tool
        ? [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]
        : [{ type: "text", text: "working on it" }],
    },
    ...overrides,
  };
}

function prLink(at, number, repository) {
  return {
    type: "pr-link",
    sessionId: BASE.sessionId,
    prNumber: number,
    prUrl: `https://github.com/${repository}/pull/${number}`,
    prRepository: repository,
    timestamp: at,
  };
}

function shift(iso, ms) {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/** A person at the keyboard: two prompts, tools in between, tens of minutes. */
function writeHumanSession(projects, { dir, id, cwd, startAt, spanMinutes, prompts }) {
  const span = spanMinutes * 60_000;
  return writeTranscript(projects, dir, id, [
    userPrompt(startAt, prompts[0], { cwd }),
    assistant(shift(startAt, 30_000), { cwd }),
    assistant(shift(startAt, 90_000), { cwd, tool: true }),
    toolResult(shift(startAt, 95_000), { cwd }),
    userPrompt(shift(startAt, span / 2), prompts[1], { cwd }),
    assistant(shift(startAt, span / 2 + 60_000), { cwd, tool: true }),
    toolResult(shift(startAt, span / 2 + 65_000), { cwd }),
    assistant(shift(startAt, span), { cwd }),
  ]);
}

/** One machine-sent prompt in a real workspace. `assistants`/`tools`/`seconds` set the shape. */
function writeAgentSession(
  projects,
  { dir, id, cwd, startAt, seconds, prompt, assistants = 1, tools = 0 },
) {
  const records = [userPrompt(startAt, prompt, { cwd })];
  for (let index = 0; index < assistants; index += 1) {
    const at = shift(startAt, Math.round(((index + 1) / assistants) * seconds * 1000));
    records.push(assistant(at, { cwd, tool: index < tools, uuid: `a-${id}-${index}` }));
  }
  return writeTranscript(projects, dir, id, records);
}

// The real senders' prompts run on for several more paragraphs after the opening the list matches,
// and their casing is nothing like the lowercased entries in MACHINE_PROMPT_PREFIXES.
const PROMPT_TAIL = [
  "",
  "Rules:",
  "- Answer with the result only: no preamble, no trailing punctuation.",
  "- Never exceed six words.",
  "",
  "Conversation so far:",
  "user: fix the flaky sync test",
].join("\n");

const TITLE_PROMPT =
  "Generate a title that will help the user recognize this T3 Code thread in a list of threads." +
  PROMPT_TAIL;
const REGEN_TITLE_PROMPT =
  "Regenerate the title for an existing T3 Code thread whose conversation has moved on." +
  PROMPT_TAIL;
const SECURITY_REVIEW_PROMPT =
  "Review this change for security vulnerabilities. Report only high-confidence findings." +
  PROMPT_TAIL;
const SECURITY_RECHECK_PROMPT =
  "You previously flagged these candidate vulnerabilities. Re-check each one against the diff." +
  PROMPT_TAIL;
const PING_PROMPT = "Say hi in one word.";
// T3code's branch-name generator: a real machine sender that nobody ever added to the list, and the
// reason the structural arm exists at all.
const BRANCH_NAME_PROMPT =
  "Generate a short kebab-case git branch name for the work described below.";

NodeTest.describe("normalizePrompt / promptHash", () => {
  NodeTest.test("trims, collapses whitespace and lowercases", () => {
    NodeAssert.equal(normalizePrompt("  Hello   \n\t WORLD \n"), "hello world");
    NodeAssert.equal(normalizePrompt("Fix\r\nthe   bug"), "fix the bug");
  });

  NodeTest.test("keeps only the first 400 characters", () => {
    const long = `${"a".repeat(399)}bcdef`;
    const normalized = normalizePrompt(long);
    NodeAssert.equal(normalized.length, 400);
    NodeAssert.ok(normalized.endsWith("ab"));
    // Everything past the cap is invisible to the hash, which is what makes the join stable when a
    // prompt gets edited in its tail.
    NodeAssert.equal(promptHash(long), promptHash(`${long}-and-much-more`));
  });

  NodeTest.test("survives non-strings", () => {
    NodeAssert.equal(normalizePrompt(undefined), "");
    NodeAssert.equal(normalizePrompt(null), "");
    NodeAssert.equal(normalizePrompt(42), "");
    NodeAssert.equal(promptHash(null), promptHash(""));
  });

  NodeTest.test("hashes the normalised form with sha256", () => {
    const expected = NodeCrypto.createHash("sha256").update("hello world", "utf8").digest("hex");
    NodeAssert.equal(promptHash("  Hello   WORLD \n"), expected);
    // Pinned literal so a refactor of the helper cannot quietly move the join key.
    NodeAssert.equal(expected, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  NodeTest.test("matches the same-named functions in lib/t3db.mjs", async (t) => {
    if (!NodeFS.existsSync(T3DB_PATH)) {
      t.skip("lib/t3db.mjs is not present yet — re-run once it lands to verify the join key");
      return;
    }
    const t3db = await import(NodeURL.pathToFileURL(T3DB_PATH).href);
    const samples = [
      "Can you get working on the following issue? #65",
      "  MIXED   Case\nAcross\tLines  ",
      "",
      `${"x".repeat(500)} tail`,
      "émoji ☕ and ünicode",
    ];
    for (const sample of samples) {
      NodeAssert.equal(
        t3db.normalizePrompt(sample),
        normalizePrompt(sample),
        `normalize: ${sample}`,
      );
      NodeAssert.equal(t3db.promptHash(sample), promptHash(sample), `hash: ${sample}`);
    }
  });
});

NodeTest.describe("listSessionFiles", () => {
  NodeTest.test("returns [] for a missing directory instead of throwing", () => {
    NodeAssert.deepEqual(listSessionFiles(NodePath.join(makeTempDir(), "nope"), { since: 0 }), []);
    NodeAssert.deepEqual(listSessionFiles(undefined, { since: 0 }), []);
    NodeAssert.deepEqual(listSessionFiles("", {}), []);
  });

  NodeTest.test("finds transcripts one level down and ignores everything else", () => {
    const projects = makeTempDir();
    writeTranscript(projects, "-Users-dev-demo", "aaa", [userPrompt(`${DAY}T10:00:00.000Z`, "hi")]);
    NodeFS.writeFileSync(NodePath.join(projects, "-Users-dev-demo", "notes.md"), "ignore me");
    NodeFS.writeFileSync(NodePath.join(projects, "loose.jsonl"), "{}\n");
    // Subagent transcripts live under <sessionId>/subagents/... and are not sessions.
    const nested = NodePath.join(
      projects,
      "-Users-dev-demo",
      "aaa",
      "subagents",
      "workflows",
      "wf",
    );
    NodeFS.mkdirSync(nested, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(nested, "agent-1.jsonl"), "{}\n");

    const found = listSessionFiles(projects, {});
    NodeAssert.deepEqual(
      found.map((entry) => entry.sessionId),
      ["aaa"],
    );
    NodeAssert.equal(found[0].dir, NodePath.join(projects, "-Users-dev-demo"));
    NodeAssert.ok(found[0].file.endsWith("aaa.jsonl"));
    NodeAssert.ok(Number.isFinite(found[0].mtimeMs));
  });

  NodeTest.test("prefilters on mtime and sorts newest first", () => {
    const projects = makeTempDir();
    const stale = writeTranscript(projects, "p1", "stale", [
      userPrompt(`${DAY}T10:00:00.000Z`, "a"),
    ]);
    const fresh = writeTranscript(projects, "p2", "fresh", [
      userPrompt(`${DAY}T11:00:00.000Z`, "b"),
    ]);
    const staleTime = new Date(WINDOW.start - 48 * 60 * 60 * 1000);
    const freshTime = new Date(WINDOW.start + 60 * 60 * 1000);
    NodeFS.utimesSync(stale, staleTime, staleTime);
    NodeFS.utimesSync(fresh, freshTime, freshTime);

    NodeAssert.deepEqual(
      listSessionFiles(projects, { since: WINDOW.start }).map((entry) => entry.sessionId),
      ["fresh"],
    );
    // A Date and an ISO string are accepted for `since` just like a number of ms.
    NodeAssert.deepEqual(
      listSessionFiles(projects, { since: new Date(WINDOW.start) }).map((e) => e.sessionId),
      ["fresh"],
    );
    NodeAssert.deepEqual(
      listSessionFiles(projects, { since: `${DAY}T00:00:00.000Z` }).map((e) => e.sessionId),
      ["fresh"],
    );
    NodeAssert.deepEqual(
      listSessionFiles(projects, {}).map((entry) => entry.sessionId),
      ["fresh", "stale"],
    );
  });
});

NodeTest.describe("readSessionFile", () => {
  NodeTest.test("summarises a whole session", async () => {
    const projects = makeTempDir();
    const file = writeTranscript(projects, "p", "s-1", [
      userPrompt(`${DAY}T10:00:00.000Z`, "Ship the release"),
      assistant(`${DAY}T10:00:30.000Z`),
      assistant(`${DAY}T10:01:00.000Z`, { tool: true }),
      toolResult(`${DAY}T10:01:05.000Z`),
      assistant(`${DAY}T10:02:00.000Z`, { model: "claude-haiku-4-5", tool: true }),
      prLink(`${DAY}T10:03:00.000Z`, 66, "radroid/t3code"),
      prLink(`${DAY}T10:04:00.000Z`, 66, "radroid/t3code"),
      prLink(`${DAY}T10:05:00.000Z`, 67, "radroid/t3code"),
      userPromptString(`${DAY}T10:10:00.000Z`, "Now write the changelog"),
      assistant(`${DAY}T10:11:00.000Z`),
    ]);

    const session = await readSessionFile(file, WINDOW);
    NodeAssert.equal(session.sessionId, "s-1");
    NodeAssert.equal(session.file, file);
    NodeAssert.equal(session.cwd, "/Users/dev/Developer/demo");
    NodeAssert.equal(session.gitBranch, "main");
    NodeAssert.deepEqual(session.versions, ["2.1.226"]);
    NodeAssert.deepEqual(session.models, ["claude-opus-5", "claude-haiku-4-5"]);
    NodeAssert.equal(session.startedAt, `${DAY}T10:00:00.000Z`);
    NodeAssert.equal(session.endedAt, `${DAY}T10:11:00.000Z`);
    NodeAssert.equal(session.promptCount, 2);
    NodeAssert.equal(session.assistantCount, 4);
    NodeAssert.equal(session.toolUseCount, 2);
    NodeAssert.equal(session.firstPrompt, "Ship the release");
    NodeAssert.equal(session.lastPrompt, "Now write the changelog");
    NodeAssert.deepEqual(session.promptHashes, [
      promptHash("Ship the release"),
      promptHash("Now write the changelog"),
    ]);
    NodeAssert.deepEqual(session.prLinks, [
      {
        number: 66,
        url: "https://github.com/radroid/t3code/pull/66",
        repository: "radroid/t3code",
        at: `${DAY}T10:03:00.000Z`,
      },
      {
        number: 67,
        url: "https://github.com/radroid/t3code/pull/67",
        repository: "radroid/t3code",
        at: `${DAY}T10:05:00.000Z`,
      },
    ]);
    NodeAssert.equal(session.eventTimes.length, 10);
    NodeAssert.deepEqual(session.eventTimes, [...session.eventTimes].sort());
    NodeAssert.deepEqual(session.turnSpans, [
      { start: `${DAY}T10:00:00.000Z`, end: `${DAY}T10:05:00.000Z` },
      { start: `${DAY}T10:10:00.000Z`, end: `${DAY}T10:11:00.000Z` },
    ]);
    NodeAssert.equal(session.sidechainOnly, false);
    NodeAssert.equal(session.excluded, null);
  });

  NodeTest.test("keeps only in-window records and returns null when none are", async () => {
    const projects = makeTempDir();
    const file = writeTranscript(projects, "p", "s-window", [
      userPrompt("2026-08-09T23:59:00.000Z", "yesterday"),
      assistant("2026-08-09T23:59:30.000Z"),
      userPrompt(`${DAY}T09:00:00.000Z`, "today"),
      assistant(`${DAY}T09:05:00.000Z`),
      userPrompt("2026-08-11T00:30:00.000Z", "tomorrow"),
    ]);

    const session = await readSessionFile(file, WINDOW);
    NodeAssert.equal(session.promptCount, 1);
    NodeAssert.equal(session.firstPrompt, "today");
    NodeAssert.equal(session.eventTimes.length, 2);
    NodeAssert.deepEqual(session.turnSpans, [
      { start: `${DAY}T09:00:00.000Z`, end: `${DAY}T09:05:00.000Z` },
    ]);

    const yesterdayOnly = await readSessionFile(file, {
      start: Date.parse("2026-08-08T00:00:00.000Z"),
      end: Date.parse("2026-08-08T23:59:59.999Z"),
    });
    NodeAssert.equal(yesterdayOnly, null);
  });

  NodeTest.test("tolerates a truncated final line and records with no timestamp", async () => {
    const projects = makeTempDir();
    const file = writeTranscript(
      projects,
      "p",
      "s-torn",
      [
        userPrompt(`${DAY}T12:00:00.000Z`, "start"),
        { type: "queue-operation", operation: "enqueue", sessionId: "s-torn" },
        assistant(`${DAY}T12:01:00.000Z`),
        '{"type":"assistant","timestamp":"2026-08-10T12:0',
      ],
      { trailingNewline: false },
    );

    const session = await readSessionFile(file, WINDOW);
    NodeAssert.equal(session.promptCount, 1);
    NodeAssert.equal(session.assistantCount, 1);
    // The un-timestamped queue-operation cannot be placed in the window, so it is not an event.
    NodeAssert.equal(session.eventTimes.length, 2);
    NodeAssert.equal(session.endedAt, `${DAY}T12:01:00.000Z`);
  });

  NodeTest.test(
    "treats wrappers and injected context as non-prompts but still as activity",
    async () => {
      const projects = makeTempDir();
      const file = writeTranscript(projects, "p", "s-wrap", [
        userPromptString(
          `${DAY}T08:00:00.000Z`,
          "<command-message>loop</command-message>\n<command-name>/loop</command-name>",
        ),
        assistant(`${DAY}T08:00:10.000Z`),
        userPromptString(
          `${DAY}T08:01:00.000Z`,
          "<local-command-stdout>Goodbye!</local-command-stdout>",
        ),
        userPrompt(`${DAY}T08:02:00.000Z`, "<system-reminder>be careful</system-reminder>"),
        userPromptString(
          `${DAY}T08:03:00.000Z`,
          "Caveat: The messages below were generated by the user while running local commands.",
        ),
        // The most common wrapper in real transcripts, and the one that leaks absolute temp paths.
        userPromptString(
          `${DAY}T08:03:30.000Z`,
          "<task-notification>\n<task-id>abc</task-id>\n<output-file>/private/tmp/x</output-file>",
        ),
        userPrompt(`${DAY}T08:04:00.000Z`, "Actually fix the flake"),
        assistant(`${DAY}T08:05:00.000Z`),
      ]);

      const session = await readSessionFile(file, WINDOW);
      NodeAssert.equal(session.promptCount, 1);
      NodeAssert.equal(session.firstPrompt, "Actually fix the flake");
      NodeAssert.equal(session.lastPrompt, "Actually fix the flake");
      NodeAssert.deepEqual(session.promptHashes, [promptHash("Actually fix the flake")]);
      // Their timestamps are still real activity, and each is still a turn boundary.
      NodeAssert.equal(session.eventTimes.length, 8);
      NodeAssert.equal(session.turnSpans.length, 6);
      NodeAssert.deepEqual(session.turnSpans.at(-1), {
        start: `${DAY}T08:04:00.000Z`,
        end: `${DAY}T08:05:00.000Z`,
      });
    },
  );

  NodeTest.test("ignores tool results and sidechain turns when counting prompts", async () => {
    const projects = makeTempDir();
    const file = writeTranscript(projects, "p", "s-side", [
      userPrompt(`${DAY}T13:00:00.000Z`, "main thread prompt"),
      toolResult(`${DAY}T13:00:05.000Z`),
      userPrompt(`${DAY}T13:00:10.000Z`, "subagent task brief", { isSidechain: true }),
      assistant(`${DAY}T13:00:20.000Z`, { isSidechain: true, tool: true }),
    ]);

    const session = await readSessionFile(file, WINDOW);
    NodeAssert.equal(session.promptCount, 1);
    NodeAssert.deepEqual(session.promptHashes, [promptHash("main thread prompt")]);
    NodeAssert.equal(session.sidechainOnly, false);
    // A sidechain turn never opens a span; it would shred the main thread's runtime.
    NodeAssert.deepEqual(session.turnSpans, [
      { start: `${DAY}T13:00:00.000Z`, end: `${DAY}T13:00:20.000Z` },
    ]);
  });

  NodeTest.test("flags a transcript that is entirely sidechain", async () => {
    const projects = makeTempDir();
    const file = writeTranscript(projects, "p", "s-only-side", [
      userPrompt(`${DAY}T14:00:00.000Z`, "do the thing", { isSidechain: true }),
      assistant(`${DAY}T14:00:30.000Z`, { isSidechain: true }),
    ]);

    const session = await readSessionFile(file, WINDOW);
    NodeAssert.equal(session.sidechainOnly, true);
    NodeAssert.equal(session.promptCount, 0);
    NodeAssert.equal(session.firstPrompt, null);
    NodeAssert.deepEqual(session.turnSpans, []);
  });

  NodeTest.test(
    "falls back to the last-prompt record when the window holds no narratable prompt",
    async () => {
      const projects = makeTempDir();
      const file = writeTranscript(projects, "p", "s-lastprompt", [
        userPrompt(`${DAY}T15:00:00.000Z`, "the original ask"),
        assistant(`${DAY}T15:00:10.000Z`),
        { type: "last-prompt", lastPrompt: "the original ask", leafUuid: "x", sessionId: "s" },
      ]);

      const wide = await readSessionFile(file, WINDOW);
      NodeAssert.equal(wide.lastPrompt, "the original ask");

      // A window that only catches the tail of the session has no prompt of its own.
      const tail = await readSessionFile(file, {
        start: Date.parse(`${DAY}T15:00:05.000Z`),
        end: WINDOW.end,
      });
      NodeAssert.equal(tail.promptCount, 0);
      NodeAssert.equal(tail.firstPrompt, null);
      NodeAssert.equal(tail.lastPrompt, "the original ask");
    },
  );

  NodeTest.test("truncates prompt text to 2000 characters", async () => {
    const projects = makeTempDir();
    const file = writeTranscript(projects, "p", "s-long", [
      userPrompt(`${DAY}T16:00:00.000Z`, "z".repeat(5000)),
    ]);

    const session = await readSessionFile(file, WINDOW);
    NodeAssert.equal(session.firstPrompt.length, 2000);
    NodeAssert.ok(session.firstPrompt.endsWith("…"));
    // The hash is taken from the full text, not the truncated copy.
    NodeAssert.deepEqual(session.promptHashes, [promptHash("z".repeat(5000))]);
  });

  NodeTest.test("takes the most frequent cwd and branch when a session moves", async () => {
    const projects = makeTempDir();
    const file = writeTranscript(projects, "p", "s-move", [
      userPrompt(`${DAY}T17:00:00.000Z`, "one", { cwd: "/a", gitBranch: "old" }),
      assistant(`${DAY}T17:01:00.000Z`, { cwd: "/b", gitBranch: "new" }),
      assistant(`${DAY}T17:02:00.000Z`, { cwd: "/b", gitBranch: "new" }),
      assistant(`${DAY}T17:03:00.000Z`, { cwd: "/b", gitBranch: "new", version: "2.1.300" }),
    ]);

    const session = await readSessionFile(file, WINDOW);
    NodeAssert.equal(session.cwd, "/b");
    NodeAssert.equal(session.gitBranch, "new");
    NodeAssert.deepEqual(session.versions, ["2.1.226", "2.1.300"]);
  });

  NodeTest.test("returns null for a missing file rather than throwing", async () => {
    const missing = NodePath.join(makeTempDir(), "gone.jsonl");
    NodeAssert.equal(await readSessionFile(missing, WINDOW), null);
  });

  NodeTest.test("returns null for an empty transcript", async () => {
    const projects = makeTempDir();
    const file = writeTranscript(projects, "p", "s-empty", []);
    NodeAssert.equal(await readSessionFile(file, WINDOW), null);
  });

  NodeTest.test("defaults to an unbounded window", async () => {
    const projects = makeTempDir();
    const file = writeTranscript(projects, "p", "s-open", [
      userPrompt("2019-01-01T00:00:00.000Z", "ancient"),
    ]);
    const session = await readSessionFile(file);
    NodeAssert.equal(session.promptCount, 1);
  });
});

NodeTest.describe("scanSessions", () => {
  NodeTest.test("collects in-window sessions and sorts them by start time", async () => {
    const projects = makeTempDir();
    writeTranscript(projects, "p-late", "later", [
      userPrompt(`${DAY}T18:00:00.000Z`, "second"),
      assistant(`${DAY}T18:01:00.000Z`),
    ]);
    writeTranscript(projects, "p-early", "earlier", [
      userPrompt(`${DAY}T09:00:00.000Z`, "first"),
      assistant(`${DAY}T09:01:00.000Z`),
    ]);
    const outside = writeTranscript(projects, "p-old", "old", [
      userPrompt("2026-08-01T09:00:00.000Z", "last week"),
    ]);
    const old = new Date(Date.parse("2026-08-01T10:00:00.000Z"));
    NodeFS.utimesSync(outside, old, old);

    const { sessions, warnings } = await scanSessions(projects, WINDOW);
    NodeAssert.deepEqual(
      sessions.map((session) => session.sessionId),
      ["earlier", "later"],
    );
    NodeAssert.deepEqual(warnings, []);
  });

  NodeTest.test("warns instead of throwing for a missing projects directory", async () => {
    const missing = NodePath.join(makeTempDir(), "no-such-dir");
    const { sessions, warnings } = await scanSessions(missing, WINDOW);
    NodeAssert.deepEqual(sessions, []);
    NodeAssert.equal(warnings.length, 1);
    NodeAssert.match(warnings[0], /not found/u);

    const unset = await scanSessions(undefined, WINDOW);
    NodeAssert.deepEqual(unset.sessions, []);
    NodeAssert.equal(unset.warnings.length, 1);
  });

  NodeTest.test("skips an entirely malformed transcript with a warning", async () => {
    const projects = makeTempDir();
    writeTranscript(projects, "p-bad", "corrupt", ["not json at all", "{oops", "]["]);
    writeTranscript(projects, "p-good", "fine", [userPrompt(`${DAY}T10:00:00.000Z`, "ok")]);

    const { sessions, warnings } = await scanSessions(projects, WINDOW);
    NodeAssert.deepEqual(
      sessions.map((session) => session.sessionId),
      ["fine"],
    );
    NodeAssert.equal(warnings.length, 1);
    NodeAssert.match(warnings[0], /corrupt\.jsonl/u);
    NodeAssert.match(warnings[0], /failed to parse/u);
  });

  NodeTest.test("keeps a partly-corrupt transcript but warns about the dropped lines", async () => {
    const projects = makeTempDir();
    writeTranscript(projects, "p", "ragged", [
      userPrompt(`${DAY}T10:00:00.000Z`, "ok"),
      "{broken",
      "also broken",
      assistant(`${DAY}T10:01:00.000Z`),
    ]);

    const { sessions, warnings } = await scanSessions(projects, WINDOW);
    NodeAssert.equal(sessions.length, 1);
    NodeAssert.equal(sessions[0].promptCount, 1);
    NodeAssert.equal(warnings.length, 1);
    NodeAssert.match(warnings[0], /Ignored 2 unparsable lines/u);
  });

  NodeTest.test("warns rather than throwing when a transcript cannot be opened", async (t) => {
    if (process.getuid?.() === 0) {
      t.skip("running as root: permissions cannot be used to make a file unreadable");
      return;
    }
    const projects = makeTempDir();
    const file = writeTranscript(projects, "p", "locked", [
      userPrompt(`${DAY}T10:00:00.000Z`, "hi"),
    ]);
    NodeFS.chmodSync(file, 0o000);
    try {
      NodeFS.readFileSync(file);
      t.skip("this filesystem ignores the permission bits");
      return;
    } catch {
      // Expected: the file really is unreadable.
    }

    const { sessions, warnings } = await scanSessions(projects, WINDOW);
    NodeAssert.deepEqual(sessions, []);
    NodeAssert.equal(warnings.length, 1);
    NodeAssert.match(warnings[0], /Could not read locked\.jsonl/u);
    NodeFS.chmodSync(file, 0o600);
  });

  NodeTest.test("caps the scan at `limit` files, newest first, and says so", async () => {
    const projects = makeTempDir();
    for (let index = 0; index < 4; index += 1) {
      const file = writeTranscript(projects, `p-${index}`, `s-${index}`, [
        userPrompt(`${DAY}T1${index}:00:00.000Z`, `prompt ${index}`),
      ]);
      const stamp = new Date(WINDOW.start + index * 60 * 60 * 1000);
      NodeFS.utimesSync(file, stamp, stamp);
    }

    const { sessions, warnings } = await scanSessions(projects, { ...WINDOW, limit: 2 });
    NodeAssert.deepEqual(
      sessions.map((session) => session.sessionId),
      ["s-2", "s-3"],
    );
    NodeAssert.equal(warnings.length, 1);
    NodeAssert.match(warnings[0], /Read only the 2 most recently modified of 4/u);
  });

  NodeTest.test("uses the window start as the mtime prefilter", async () => {
    const projects = makeTempDir();
    // In-window records, but the file was last written before the window opened — impossible in
    // practice, and the cheap prefilter is what keeps a full scan off the hot path.
    const file = writeTranscript(projects, "p", "s-stale-mtime", [
      userPrompt(`${DAY}T10:00:00.000Z`, "hi"),
    ]);
    const stale = new Date(WINDOW.start - 60 * 60 * 1000);
    NodeFS.utimesSync(file, stale, stale);

    const { sessions } = await scanSessions(projects, WINDOW);
    NodeAssert.deepEqual(sessions, []);

    const widened = await scanSessions(projects, {
      start: WINDOW.start - 86_400_000,
      end: WINDOW.end,
    });
    NodeAssert.deepEqual(
      widened.sessions.map((session) => session.sessionId),
      ["s-stale-mtime"],
    );
  });
});

NodeTest.describe("linkSessions", () => {
  const t3codeThread = {
    threadId: "thread-abc",
    worktreePath: "/Users/dev/.t3/worktrees/demo/demo-1234",
  };

  function session(overrides) {
    return { sessionId: "s", cwd: null, promptHashes: [], excluded: undefined, ...overrides };
  }

  NodeTest.test("rule 1: a cwd under a worktree root is t3code-driven", () => {
    const withThread = session({ cwd: "/Users/dev/.t3/worktrees/demo/demo-1234/apps/server" });
    const withoutThread = session({ cwd: "/Users/dev/.t3/worktrees/other/other-9999" });

    linkSessions([withThread, withoutThread], {
      threads: [t3codeThread],
      worktreeRoots: ["/Users/dev/.t3/worktrees"],
      promptHashes: new Map(),
    });

    NodeAssert.deepEqual(withThread.excluded, {
      reason: "t3code-driven",
      rule: "worktree",
      linkedTo: "thread-abc",
    });
    // Still excluded, just not attributable to a specific thread.
    NodeAssert.deepEqual(withoutThread.excluded, {
      reason: "t3code-driven",
      rule: "worktree",
      linkedTo: null,
    });
  });

  NodeTest.test(
    "rule 1 matches a worktree root exactly and does not match a sibling prefix",
    () => {
      const exact = session({ cwd: "/Users/dev/.t3/worktrees" });
      const sibling = session({ cwd: "/Users/dev/.t3/worktrees-backup/thing" });

      linkSessions([exact, sibling], { worktreeRoots: ["/Users/dev/.t3/worktrees/"] });

      NodeAssert.equal(exact.excluded.rule, "worktree");
      NodeAssert.equal(sibling.excluded, null);
    },
  );

  NodeTest.test("rule 2: a shared prompt hash links a session to its thread", () => {
    const hash = promptHash("Sync the fork with upstream");
    const target = session({
      cwd: "/Users/dev/Developer/t3code",
      promptHashes: [promptHash("something else"), hash],
    });

    linkSessions([target], {
      threads: [t3codeThread],
      worktreeRoots: ["/Users/dev/.t3/worktrees"],
      promptHashes: new Map([[hash, { threadId: "thread-xyz" }]]),
    });

    NodeAssert.deepEqual(target.excluded, {
      reason: "t3code-driven",
      rule: "prompt-hash",
      linkedTo: "thread-xyz",
    });
  });

  NodeTest.test("rule 3: anything else stands alone", () => {
    const standalone = session({
      cwd: "/Users/dev/Developer/side-project",
      promptHashes: [promptHash("unrelated work")],
    });

    linkSessions([standalone], {
      threads: [t3codeThread],
      worktreeRoots: ["/Users/dev/.t3/worktrees"],
      promptHashes: new Map([[promptHash("Sync the fork"), { threadId: "thread-xyz" }]]),
    });

    NodeAssert.equal(standalone.excluded, null);
  });

  NodeTest.test("the worktree rule wins over a matching prompt hash", () => {
    const hash = promptHash("shared prompt");
    const target = session({
      cwd: "/Users/dev/.t3/worktrees/demo/demo-1234",
      promptHashes: [hash],
    });

    linkSessions([target], {
      threads: [t3codeThread],
      worktreeRoots: ["/Users/dev/.t3/worktrees"],
      promptHashes: new Map([[hash, { threadId: "thread-hash" }]]),
    });

    NodeAssert.equal(target.excluded.rule, "worktree");
    NodeAssert.equal(target.excluded.linkedTo, "thread-abc");
  });

  NodeTest.test("returns the same array and tolerates thin or absent inputs", () => {
    const target = session({ cwd: null });
    const list = [target, null];
    NodeAssert.equal(linkSessions(list), list);
    NodeAssert.equal(target.excluded, null);
    NodeAssert.deepEqual(linkSessions(undefined), []);

    // A snake_case thread row and a plain-object hash table are both accepted.
    const snake = session({ cwd: "/srv/work/repo" });
    linkSessions([snake], { threads: [{ thread_id: "t-9", worktree_path: "/srv/work/repo" }] });
    NodeAssert.deepEqual(snake.excluded, {
      reason: "t3code-driven",
      rule: "worktree",
      linkedTo: "t-9",
    });

    const viaObject = session({ cwd: "/elsewhere", promptHashes: ["deadbeef"] });
    linkSessions([viaObject], { promptHashes: { deadbeef: { threadId: "t-obj" } } });
    NodeAssert.equal(viaObject.excluded.linkedTo, "t-obj");
  });
});

NodeTest.describe("isMachineSession", () => {
  /** Defaults are a person working: nothing but the prompt text can make this machine-generated. */
  function machineCandidate(overrides = {}) {
    return {
      sessionId: "candidate",
      cwd: "/Users/dev/Developer/demo",
      promptHashes: [],
      firstPrompt: "Fix the flaky sync test and explain what was racing",
      promptCount: 3,
      assistantCount: 12,
      toolUseCount: 9,
      startedAt: `${DAY}T10:00:00.000Z`,
      endedAt: `${DAY}T10:45:00.000Z`,
      excluded: undefined,
      ...overrides,
    };
  }

  const titleCase = (text) => text.replace(/\b\w/gu, (character) => character.toUpperCase());

  NodeTest.test("the prefix list is the pinned set of verified machine senders", () => {
    // Pinned literally: dropping an entry silently re-inflates the session count, and the
    // per-prefix tests below are generated from this list so they cannot catch a deletion.
    NodeAssert.deepEqual(
      [...MACHINE_PROMPT_PREFIXES],
      [
        "generate a title that will help the user recognize this t3 code thread",
        "regenerate the title for an existing t3 code thread",
        "review this change for security vulnerabilities",
        "you previously flagged these candidate vulnerabilities",
        "say hi in one word",
        "you write concise git commit messages",
        "you generate concise git branch names",
        "you write source control change request content",
        "you write concise thread titles",
      ],
    );
    NodeAssert.ok(Object.isFrozen(MACHINE_PROMPT_PREFIXES));
    for (const prefix of MACHINE_PROMPT_PREFIXES) {
      // Matching lowercases the prompt but not the list, so an entry with a capital never fires.
      NodeAssert.equal(prefix, prefix.toLowerCase(), `prefix must be stored lowercased: ${prefix}`);
      NodeAssert.equal(prefix, prefix.trim(), `prefix must not carry padding: ${prefix}`);
    }
  });

  NodeTest.test("machine-directive catches a system prompt nobody has listed yet", () => {
    // The literal list cannot keep up on its own: "You write concise thread titles for coding
    // conversations." is from an older T3code build and was counted as two real sessions on
    // 2026-08-08 until this arm existed. These are phrasings that are NOT on the list.
    for (const prompt of [
      "You are a helpful assistant that names things.",
      "You produce short release notes from a diff.",
      "You classify support tickets by urgency.",
      "You summarise a code review in one paragraph.",
    ]) {
      NodeAssert.deepEqual(
        isMachineSession(machineCandidate({ firstPrompt: prompt, promptCount: 1 })),
        { machine: true, rule: "machine-directive" },
        `should have been caught: ${prompt}`,
      );
    }
  });

  NodeTest.test(
    "machine-directive does not swallow a person who happens to open with 'You'",
    () => {
      // The shape alone is not enough — a human who opens like this keeps talking, so the arm
      // additionally requires a session of at most two prompts.
      NodeAssert.deepEqual(
        isMachineSession({
          ...machineCandidate({ firstPrompt: "You generate the report and I'll review it." }),
          promptCount: 5,
        }),
        { machine: false, rule: null },
      );

      // And these never match the shape at all, however short the session.
      for (const prompt of [
        "You generate the report and I'll review it, but first check the schema",
        "Your deploy script is broken.",
        "You know what? Let's revert it.",
        "You generate branch names?",
        "You write concise git commit messages\nand also please fix the linter.",
      ]) {
        const verdict = isMachineSession(machineCandidate({ firstPrompt: prompt, promptCount: 1 }));
        NodeAssert.notEqual(verdict.rule, "machine-directive", `false positive on: ${prompt}`);
      }
    },
  );

  for (const prefix of MACHINE_PROMPT_PREFIXES) {
    NodeTest.test(`known-prompt: a session opening with "${prefix}" is machine-generated`, () => {
      // Control: this shape is not machine-like on its own, so every assertion below is the
      // prefix doing the work and not the structural arm.
      NodeAssert.deepEqual(isMachineSession(machineCandidate()), { machine: false, rule: null });

      const expected = { machine: true, rule: "known-prompt" };
      NodeAssert.deepEqual(isMachineSession(machineCandidate({ firstPrompt: prefix })), expected);

      // Prefix-based: the real prompts continue for several more paragraphs after the opening.
      const continued = `${prefix}. ${PROMPT_TAIL}`;
      NodeAssert.ok(continued.length > prefix.length + 100);
      NodeAssert.deepEqual(
        isMachineSession(machineCandidate({ firstPrompt: continued })),
        expected,
      );

      // Case-insensitive in both directions, and leading whitespace is trimmed off first.
      NodeAssert.deepEqual(
        isMachineSession(
          machineCandidate({ firstPrompt: `${prefix.toUpperCase()}. ${PROMPT_TAIL}` }),
        ),
        expected,
      );
      NodeAssert.deepEqual(
        isMachineSession(
          machineCandidate({ firstPrompt: `\n  ${titleCase(prefix)}. ${PROMPT_TAIL}` }),
        ),
        expected,
      );

      // And the ladder turns that into the exclusion record the bundle carries.
      const session = machineCandidate({ firstPrompt: continued });
      linkSessions([session]);
      NodeAssert.deepEqual(session.excluded, {
        reason: "machine-generated",
        rule: "known-prompt",
        linkedTo: null,
      });
    });
  }

  NodeTest.test(
    "utility-shape: a one-prompt, one-tool, 7-second session with an unknown prompt",
    () => {
      // This is T3code's branch-name generator, which nobody ever put on the prefix list.
      NodeAssert.ok(
        !MACHINE_PROMPT_PREFIXES.some((prefix) =>
          BRANCH_NAME_PROMPT.toLowerCase().startsWith(prefix),
        ),
        "BRANCH_NAME_PROMPT must stay off the prefix list or this test proves nothing",
      );

      const session = machineCandidate({
        firstPrompt: BRANCH_NAME_PROMPT,
        promptCount: 1,
        assistantCount: 2,
        toolUseCount: 1,
        startedAt: `${DAY}T10:00:00.000Z`,
        endedAt: `${DAY}T10:00:07.000Z`,
      });
      NodeAssert.deepEqual(isMachineSession(session), { machine: true, rule: "utility-shape" });

      linkSessions([session]);
      NodeAssert.deepEqual(session.excluded, {
        reason: "machine-generated",
        rule: "utility-shape",
        linkedTo: null,
      });
    },
  );

  NodeTest.test("utility-shape stops one millisecond short of two minutes", () => {
    const utility = (durationMs) =>
      isMachineSession(
        machineCandidate({
          firstPrompt: BRANCH_NAME_PROMPT,
          promptCount: 1,
          assistantCount: 2,
          toolUseCount: 1,
          startedAt: `${DAY}T10:00:00.000Z`,
          endedAt: shift(`${DAY}T10:00:00.000Z`, durationMs),
        }),
      );

    NodeAssert.deepEqual(utility(0), { machine: true, rule: "utility-shape" });
    NodeAssert.deepEqual(utility(119_999), { machine: true, rule: "utility-shape" });
    NodeAssert.deepEqual(utility(120_000), { machine: false, rule: null });
    NodeAssert.deepEqual(utility(120_001), { machine: false, rule: null });
  });

  // The false-positive guard. Each of these trips exactly one clause of the structural arm, so a
  // clause that goes missing shows up here as a genuine short session being swallowed.
  NodeTest.test("a short session with two prompts is a person, not a utility", () => {
    const session = machineCandidate({
      firstPrompt: "why is this test flaky",
      promptCount: 2,
      assistantCount: 2,
      toolUseCount: 1,
      startedAt: `${DAY}T10:00:00.000Z`,
      endedAt: `${DAY}T10:00:40.000Z`,
    });
    NodeAssert.deepEqual(isMachineSession(session), { machine: false, rule: null });
    linkSessions([session]);
    NodeAssert.equal(session.excluded, null);
  });

  NodeTest.test("a one-prompt session with five tool uses is a person, not a utility", () => {
    const session = machineCandidate({
      firstPrompt: "find every caller of renderSummary",
      promptCount: 1,
      assistantCount: 2,
      toolUseCount: 5,
      startedAt: `${DAY}T10:00:00.000Z`,
      endedAt: `${DAY}T10:01:10.000Z`,
    });
    NodeAssert.deepEqual(isMachineSession(session), { machine: false, rule: null });
    linkSessions([session]);
    NodeAssert.equal(session.excluded, null);
  });

  NodeTest.test(
    "a one-prompt, one-tool session lasting ten minutes is a person, not a utility",
    () => {
      const session = machineCandidate({
        firstPrompt: "read the design doc and tell me if §6 still matches the code",
        promptCount: 1,
        assistantCount: 2,
        toolUseCount: 1,
        startedAt: `${DAY}T10:00:00.000Z`,
        endedAt: `${DAY}T10:10:00.000Z`,
      });
      NodeAssert.deepEqual(isMachineSession(session), { machine: false, rule: null });
      linkSessions([session]);
      NodeAssert.equal(session.excluded, null);
    },
  );

  NodeTest.test("a prompt that merely contains a machine prefix is not machine-generated", () => {
    const session = machineCandidate({
      firstPrompt:
        "Can you explain where we generate a title that will help the user recognize this T3 Code thread?",
    });
    NodeAssert.deepEqual(isMachineSession(session), { machine: false, rule: null });
    linkSessions([session]);
    NodeAssert.equal(session.excluded, null);
  });

  NodeTest.test("never throws on thin, empty or non-string input", () => {
    const cases = [
      ["no argument at all", undefined],
      ["a null session", null],
      ["a completely empty object", {}],
      ["an absent firstPrompt", { promptCount: 4, assistantCount: 9, toolUseCount: 7 }],
      ["a null firstPrompt", { firstPrompt: null }],
      ["an empty firstPrompt", { firstPrompt: "" }],
      ["a whitespace-only firstPrompt", { firstPrompt: "  \n\t " }],
      ["a numeric firstPrompt", { firstPrompt: 42 }],
      ["an object firstPrompt", { firstPrompt: { text: "hi" } }],
      ["an array firstPrompt", { firstPrompt: [] }],
      ["unparseable timestamps", { firstPrompt: "hi", startedAt: "not-a-date", endedAt: "nope" }],
      ["only a startedAt", { firstPrompt: "hi", startedAt: `${DAY}T10:00:00.000Z` }],
      ["only an endedAt", { firstPrompt: "hi", endedAt: `${DAY}T10:00:00.000Z` }],
    ];
    for (const [label, input] of cases) {
      // Without a measurable duration the structural arm cannot fire, so all of these are people.
      NodeAssert.deepEqual(isMachineSession(input), { machine: false, rule: null }, label);
    }

    // A known prompt is decided before the timestamps are read, so it survives having none.
    NodeAssert.deepEqual(isMachineSession({ firstPrompt: TITLE_PROMPT }), {
      machine: true,
      rule: "known-prompt",
    });
    // And timestamps alone are everything the structural arm needs.
    NodeAssert.deepEqual(
      isMachineSession({ startedAt: `${DAY}T10:00:00.000Z`, endedAt: `${DAY}T10:00:03.000Z` }),
      { machine: true, rule: "utility-shape" },
    );
  });
});

NodeTest.describe("linkSessions: the machine rung outranks the t3code rungs", () => {
  const worktree = "/Users/dev/.t3/worktrees/demo/demo-1234";
  const options = {
    threads: [{ threadId: "thread-abc", worktreePath: worktree }],
    worktreeRoots: ["/Users/dev/.t3/worktrees"],
    promptHashes: new Map([[promptHash(TITLE_PROMPT), { threadId: "thread-hash" }]]),
  };

  function inWorktree(overrides) {
    return {
      sessionId: "s",
      cwd: `${worktree}/apps/server`,
      promptHashes: [promptHash(TITLE_PROMPT)],
      excluded: undefined,
      ...overrides,
    };
  }

  NodeTest.test("a known machine prompt under a worktree root reports machine-generated", () => {
    const session = inWorktree({
      firstPrompt: TITLE_PROMPT,
      promptCount: 3,
      assistantCount: 12,
      toolUseCount: 9,
      startedAt: `${DAY}T10:00:00.000Z`,
      endedAt: `${DAY}T10:45:00.000Z`,
    });
    linkSessions([session], options);
    NodeAssert.deepEqual(session.excluded, {
      reason: "machine-generated",
      rule: "known-prompt",
      linkedTo: null,
    });

    // Control: the identical placement with a human prompt lands on the worktree rung, so the
    // assertion above is the more specific reason winning, not the other rungs failing to arm.
    const human = inWorktree({
      firstPrompt: "Rebase the fork onto upstream",
      promptCount: 3,
      assistantCount: 12,
      toolUseCount: 9,
      startedAt: `${DAY}T10:00:00.000Z`,
      endedAt: `${DAY}T10:45:00.000Z`,
    });
    linkSessions([human], options);
    NodeAssert.deepEqual(human.excluded, {
      reason: "t3code-driven",
      rule: "worktree",
      linkedTo: "thread-abc",
    });
  });

  NodeTest.test(
    "a utility-shaped session under a worktree root reports machine-generated too",
    () => {
      const session = inWorktree({
        firstPrompt: BRANCH_NAME_PROMPT,
        promptCount: 1,
        assistantCount: 2,
        toolUseCount: 1,
        startedAt: `${DAY}T11:00:00.000Z`,
        endedAt: `${DAY}T11:00:07.000Z`,
      });
      linkSessions([session], options);
      NodeAssert.deepEqual(session.excluded, {
        reason: "machine-generated",
        rule: "utility-shape",
        linkedTo: null,
      });
    },
  );

  NodeTest.test("the machine rung also outranks the prompt-hash rung", () => {
    const session = {
      sessionId: "s",
      cwd: "/Users/dev/Developer/t3code",
      promptHashes: [promptHash(TITLE_PROMPT)],
      firstPrompt: TITLE_PROMPT,
      promptCount: 3,
      assistantCount: 12,
      toolUseCount: 9,
      startedAt: `${DAY}T12:00:00.000Z`,
      endedAt: `${DAY}T12:40:00.000Z`,
      excluded: undefined,
    };
    linkSessions([session], options);
    NodeAssert.deepEqual(session.excluded, {
      reason: "machine-generated",
      rule: "known-prompt",
      linkedTo: null,
    });

    // Control: the same hash, with a human prompt, is the prompt-hash rung's job.
    const human = { ...session, firstPrompt: "Rebase the fork onto upstream", excluded: undefined };
    linkSessions([human], options);
    NodeAssert.deepEqual(human.excluded, {
      reason: "t3code-driven",
      rule: "prompt-hash",
      linkedTo: "thread-hash",
    });
  });
});

NodeTest.describe("end to end over a fixture projects directory", () => {
  NodeTest.test("scan then link produces an auditable, deduped set", async () => {
    const projects = makeTempDir();
    const sharedPrompt = "Rebase the fork onto upstream";

    writeTranscript(projects, "-Users-dev--t3-worktrees-demo-demo-1234", "driven", [
      userPrompt(`${DAY}T09:00:00.000Z`, "do the sync", {
        cwd: "/Users/dev/.t3/worktrees/demo/demo-1234",
      }),
      assistant(`${DAY}T09:30:00.000Z`, { cwd: "/Users/dev/.t3/worktrees/demo/demo-1234" }),
    ]);
    writeTranscript(projects, "-Users-dev-Developer-t3code", "mirrored", [
      userPrompt(`${DAY}T10:00:00.000Z`, sharedPrompt, { cwd: "/Users/dev/Developer/t3code" }),
      assistant(`${DAY}T10:20:00.000Z`, { cwd: "/Users/dev/Developer/t3code" }),
    ]);
    writeTranscript(projects, "-Users-dev-Developer-solo", "solo", [
      userPrompt(`${DAY}T11:00:00.000Z`, "write the blog post", {
        cwd: "/Users/dev/Developer/solo",
      }),
      assistant(`${DAY}T11:05:00.000Z`, { cwd: "/Users/dev/Developer/solo" }),
    ]);

    const { sessions, warnings } = await scanSessions(projects, WINDOW);
    NodeAssert.deepEqual(warnings, []);
    linkSessions(sessions, {
      threads: [
        { threadId: "thread-abc", worktreePath: "/Users/dev/.t3/worktrees/demo/demo-1234" },
      ],
      worktreeRoots: ["/Users/dev/.t3/worktrees"],
      promptHashes: new Map([[promptHash(sharedPrompt), { threadId: "thread-def" }]]),
    });

    NodeAssert.deepEqual(
      sessions.map((s) => [s.sessionId, s.excluded?.rule ?? null, s.excluded?.linkedTo ?? null]),
      [
        ["driven", "worktree", "thread-abc"],
        ["mirrored", "prompt-hash", "thread-def"],
        ["solo", null, null],
      ],
    );
    // Linked sessions stay in the list so the join stays auditable (design §6).
    NodeAssert.equal(sessions.length, 3);
  });

  NodeTest.test(
    "a real-shaped day: 12 transcripts on disk, 5 of them are a person working",
    async () => {
      // 2026-08-10 in miniature. On the real day this shape reported 43 sessions for 13 threads:
      // T3code's thread-title generation, the security-guidance plugin's review calls, the branch-name
      // generator and a provider ping each open a real Claude Code session in a real workspace.
      const projects = makeTempDir();
      const worktreeA = "/Users/dev/.t3/worktrees/t3code/t3code-8dee628e";
      const worktreeB = "/Users/dev/.t3/worktrees/t3code/t3code-77aa11bb";
      const files = [];

      // --- five genuine sessions ---
      files.push(
        writeHumanSession(projects, {
          dir: "-Users-dev-Developer-api",
          id: "api-refactor",
          cwd: "/Users/dev/Developer/api",
          startAt: `${DAY}T09:00:00.000Z`,
          spanMinutes: 26,
          prompts: ["Split the billing controller in two", "Now port the tests over"],
        }),
        writeHumanSession(projects, {
          dir: "-Users-dev-Developer-mission-control-inbox-lens",
          id: "inbox-lens",
          cwd: "/Users/dev/Developer/mission-control/inbox-lens",
          startAt: `${DAY}T09:40:00.000Z`,
          spanMinutes: 30,
          prompts: ["Wire the digest job to the new queue", "Add a backoff on the 429"],
        }),
        writeHumanSession(projects, {
          dir: "-Users-dev-Developer-t3code",
          id: "worklog-skill",
          cwd: "/Users/dev/Developer/t3code",
          startAt: `${DAY}T10:30:00.000Z`,
          spanMinutes: 45,
          prompts: ["Build the worklog collector", "Re-point the CLI at the real modules"],
        }),
        writeHumanSession(projects, {
          dir: "-Users-dev-Developer-notes",
          id: "docs-pass",
          cwd: "/Users/dev/Developer/notes",
          startAt: `${DAY}T11:30:00.000Z`,
          spanMinutes: 22,
          prompts: ["Rewrite the setup guide intro", "Trim the troubleshooting page"],
        }),
        writeHumanSession(projects, {
          dir: "-Users-dev-Developer-t3code",
          id: "release-cut",
          cwd: "/Users/dev/Developer/t3code",
          startAt: `${DAY}T13:00:00.000Z`,
          spanMinutes: 40,
          prompts: ["Cut build 21", "Check the relay notified /latest"],
        }),
      );

      // --- thread-title generation: tiny, and it runs inside the thread's own worktree ---
      files.push(
        writeAgentSession(projects, {
          dir: "-Users-dev--t3-worktrees-t3code-t3code-8dee628e",
          id: "title-1",
          cwd: worktreeA,
          startAt: `${DAY}T09:05:00.000Z`,
          seconds: 4,
          prompt: TITLE_PROMPT,
        }),
        writeAgentSession(projects, {
          dir: "-Users-dev--t3-worktrees-t3code-t3code-77aa11bb",
          id: "title-2",
          cwd: worktreeB,
          startAt: `${DAY}T10:35:00.000Z`,
          seconds: 3,
          prompt: TITLE_PROMPT,
        }),
        writeAgentSession(projects, {
          dir: "-Users-dev--t3-worktrees-t3code-t3code-8dee628e",
          id: "regen-title",
          cwd: worktreeA,
          startAt: `${DAY}T12:00:00.000Z`,
          seconds: 5,
          prompt: REGEN_TITLE_PROMPT,
        }),
      );

      // --- security review: long, chatty and tool-heavy, so ONLY the prefix list can catch it ---
      files.push(
        writeAgentSession(projects, {
          dir: "-Users-dev-Developer-api",
          id: "security-1",
          cwd: "/Users/dev/Developer/api",
          startAt: `${DAY}T10:00:00.000Z`,
          seconds: 180,
          prompt: SECURITY_REVIEW_PROMPT,
          assistants: 4,
          tools: 3,
        }),
        writeAgentSession(projects, {
          dir: "-Users-dev-Developer-t3code",
          id: "security-2",
          cwd: "/Users/dev/Developer/t3code",
          startAt: `${DAY}T12:10:00.000Z`,
          seconds: 180,
          prompt: SECURITY_RECHECK_PROMPT,
          assistants: 4,
          tools: 3,
        }),
      );

      // --- the branch-name generator (on no list) and a provider reachability ping ---
      files.push(
        writeAgentSession(projects, {
          dir: "-Users-dev-Developer-t3code",
          id: "branch-name",
          cwd: "/Users/dev/Developer/t3code",
          startAt: `${DAY}T11:00:00.000Z`,
          seconds: 7,
          prompt: BRANCH_NAME_PROMPT,
          assistants: 2,
          tools: 1,
        }),
        writeAgentSession(projects, {
          dir: "-Users-dev",
          id: "ping",
          cwd: "/Users/dev",
          startAt: `${DAY}T13:05:00.000Z`,
          seconds: 1,
          prompt: PING_PROMPT,
        }),
      );

      // Pin every mtime inside the window so the cheap prefilter cannot depend on the wall clock.
      const stamp = new Date(WINDOW.start + 20 * 60 * 60 * 1000);
      for (const file of files) NodeFS.utimesSync(file, stamp, stamp);

      const { sessions, warnings } = await scanSessions(projects, WINDOW);
      NodeAssert.deepEqual(warnings, []);
      // Everything on disk is read and kept: the ladder classifies, it never drops a row.
      NodeAssert.equal(sessions.length, 12);

      const linkOptions = {
        threads: [{ threadId: "thread-abc", worktreePath: worktreeA }],
        worktreeRoots: ["/Users/dev/.t3/worktrees"],
        promptHashes: new Map([[promptHash(TITLE_PROMPT), { threadId: "thread-title" }]]),
      };
      linkSessions(sessions, linkOptions);

      NodeAssert.deepEqual(
        sessions.map((s) => [s.sessionId, s.excluded?.reason ?? null, s.excluded?.rule ?? null]),
        [
          ["api-refactor", null, null],
          ["title-1", "machine-generated", "known-prompt"],
          ["inbox-lens", null, null],
          ["security-1", "machine-generated", "known-prompt"],
          ["worklog-skill", null, null],
          ["title-2", "machine-generated", "known-prompt"],
          ["branch-name", "machine-generated", "utility-shape"],
          ["docs-pass", null, null],
          ["regen-title", "machine-generated", "known-prompt"],
          ["security-2", "machine-generated", "known-prompt"],
          ["release-cut", null, null],
          ["ping", "machine-generated", "known-prompt"],
        ],
      );

      const genuine = sessions.filter((s) => s.excluded === null).map((s) => s.sessionId);
      NodeAssert.deepEqual(genuine, [
        "api-refactor",
        "inbox-lens",
        "worklog-skill",
        "docs-pass",
        "release-cut",
      ]);
      // The regression guard: the day is five sessions of work, not twelve.
      NodeAssert.equal(genuine.length, 5);
      NodeAssert.equal(sessions.length - genuine.length, 7);

      // title-1 is armed on all three rungs at once — worktree, named thread, and prompt hash — and
      // still reports the most specific reason, naming no thread.
      const titleOne = sessions.find((s) => s.sessionId === "title-1");
      NodeAssert.equal(titleOne.cwd, worktreeA);
      NodeAssert.deepEqual(titleOne.promptHashes, [promptHash(TITLE_PROMPT)]);
      NodeAssert.deepEqual(titleOne.excluded, {
        reason: "machine-generated",
        rule: "known-prompt",
        linkedTo: null,
      });
      // Control: the same session with a person behind it lands on the worktree rung, which proves
      // the row above is the machine rung winning rather than the others failing to arm.
      const asHuman = { ...titleOne, firstPrompt: "Rebase the fork onto upstream", promptCount: 3 };
      linkSessions([asHuman], linkOptions);
      NodeAssert.deepEqual(asHuman.excluded, {
        reason: "t3code-driven",
        rule: "worktree",
        linkedTo: "thread-abc",
      });

      // The security reviews are structurally indistinguishable from work — four assistant turns,
      // three tool uses, three minutes — so the prefix list is the only thing holding them out.
      const security = sessions.find((s) => s.sessionId === "security-1");
      NodeAssert.equal(security.assistantCount, 4);
      NodeAssert.equal(security.toolUseCount, 3);
      NodeAssert.equal(Date.parse(security.endedAt) - Date.parse(security.startedAt), 180_000);
      NodeAssert.deepEqual(
        isMachineSession({ ...security, firstPrompt: "Review the queue design" }),
        {
          machine: false,
          rule: null,
        },
      );
    },
  );
});
