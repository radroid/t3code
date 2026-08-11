// The CLI is the only module a human types at, so these tests drive it exactly the way a human
// (or the skill) does: through `main(argv, io, deps)`.
//
// Nothing here reads the user's real data. Every test builds a throwaway worklog repo under
// `mkdtemp`, points HOME and the three WORKLOG_* overrides at it, injects a fake shell runner in
// place of git/gh, and hands the CLI fake modules. A test that shells out or opens `~/.t3` is a
// test that would fail on somebody else's machine — and a read-only guarantee is only worth
// anything if the suite proves it.
//
// The fakes are injected under the REAL module names — `bundle`, `summary`, `extract`, `init` —
// because `loadModule(ctx, name)` prefers `ctx.deps[name]` and otherwise imports `../lib/<name>.mjs`.
// That is deliberate: these tests are the contract between the CLI and its libraries, so a library
// that renames or reshapes an export must break here rather than in a user's terminal. The CLI has
// no fallbacks left — a module that does not answer is a crash (exit 3), not a quiet degradation.

import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { commandCatalogue, main } from "../bin/worklog.mjs";
import { tildify } from "../lib/paths.mjs";
import { renderSummary } from "../lib/summary.mjs";

const DAY = "2026-08-10";

const BUNDLE = {
  schemaVersion: 1,
  generatedAt: "2026-08-10T12:00:00.000Z",
  warnings: [],
  range: { from: DAY, to: DAY, days: [DAY], timezone: "America/Toronto" },
  sessions: [
    {
      key: "t3-abc",
      kind: "t3code",
      title: "Sync fork with upstream",
      turnCount: 11,
      agentRuntimeMs: 3_600_000,
      excluded: null,
    },
    { key: "cc-def", kind: "claude-code", title: "Linked", excluded: { reason: "t3code-driven" } },
  ],
  stats: { sessions: 1, turns: 11, commits: 3, activeMs: 5_400_000, agentRuntimeMs: 3_600_000 },
};

const CLEAN_DAY_FILE = "# 2026-08-10\n\nShipped the redaction gate.\n";
const LEAKY_DAY_FILE = "# 2026-08-10\n\nKey was sk-abcdefghijklmnopqrst all along.\n";

// --- harness --------------------------------------------------------------------------------------

/** Runs the CLI with captured streams; returns the exit code plus everything it printed. */
async function runCli(argv, { deps = {}, cwd = "/nonexistent" } = {}) {
  const stdout = [];
  const stderr = [];
  const exits = [];
  const code = await main(
    argv,
    {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      exit: (value) => exits.push(value),
      cwd,
    },
    deps,
  );
  return {
    code,
    out: stdout.join(""),
    err: stderr.join(""),
    all: stdout.join("") + stderr.join(""),
    exits,
  };
}

/** Sets env vars for the duration of one test and puts the originals back afterwards. */
function withEnv(t, vars) {
  const saved = new Map();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** A throwaway home with a worklog repo, a T3 base dir and a Claude Code projects dir in it. */
function sandbox(t) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worklog-"));
  t.after(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  const root = NodePath.join(dir, "worklog");
  const t3 = NodePath.join(dir, "t3-userdata");
  const claude = NodePath.join(dir, "claude-projects");
  NodeFS.mkdirSync(t3, { recursive: true });
  NodeFS.mkdirSync(claude, { recursive: true });
  withEnv(t, {
    HOME: dir,
    WORKLOG_ROOT: root,
    WORKLOG_T3_BASE_DIRS: t3,
    WORKLOG_CLAUDE_PROJECTS: claude,
  });
  return { dir, root, t3, claude };
}

/** A sandbox pre-loaded with the fixtures every command needs: a day file, a bundle, a payload. */
function scenario(t) {
  const box = sandbox(t);
  NodeFS.mkdirSync(NodePath.join(box.root, "days"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(box.root, ".worklog-tmp", "bundles"), { recursive: true });

  const dayFile = NodePath.join(box.root, "days", `${DAY}.md`);
  NodeFS.writeFileSync(dayFile, CLEAN_DAY_FILE, "utf8");

  const bundlePath = NodePath.join(
    box.root,
    ".worklog-tmp",
    "bundles",
    `bundle-${DAY}_${DAY}.json`,
  );
  NodeFS.writeFileSync(bundlePath, JSON.stringify(BUNDLE), "utf8");

  const payloadFile = NodePath.join(box.dir, "extract.json");
  NodeFS.writeFileSync(
    payloadFile,
    JSON.stringify({ problem: "p", approach: "a", outcome: "o", artifacts: [], status: "done" }),
    "utf8",
  );
  return { ...box, dayFile, bundlePath, payloadFile };
}

/** A recording stand-in for `lib/git.mjs`'s runner; the handler answers by command line. */
function makeRun(handler = () => ({})) {
  const calls = [];
  const run = (cmd, args = [], options = {}) => {
    const key = [cmd, ...args].join(" ");
    calls.push({ cmd, args, key, cwd: options.cwd });
    return {
      ok: false,
      code: 1,
      stdout: "",
      stderr: "",
      ...handler(key, { cmd, args, options }),
    };
  };
  run.calls = calls;
  return run;
}

/** A runner that behaves like a healthy worklog git repo with one modified day file. */
function repoRun(root, overrides = {}) {
  return makeRun((key) => {
    if (Object.hasOwn(overrides, key)) return overrides[key];
    if (key === "git rev-parse --is-inside-work-tree")
      return { ok: true, code: 0, stdout: "true\n" };
    if (key === "git rev-parse --show-toplevel") return { ok: true, code: 0, stdout: `${root}\n` };
    if (key === "git rev-parse --short HEAD") return { ok: true, code: 0, stdout: "abc1234\n" };
    if (key.startsWith("git status")) return { ok: true, code: 0, stdout: ` M days/${DAY}.md\n` };
    if (key.startsWith("git add")) return { ok: true, code: 0 };
    // `git diff --cached --name-only -z` answers with the NUL-separated staged paths — that list
    // is both the "is there anything to commit" test and the commit's pathspec.
    if (key.startsWith("git diff")) return { ok: true, code: 0, stdout: `days/${DAY}.md\0` };
    if (key.startsWith("git commit"))
      return { ok: true, code: 0, stdout: "[main abc1234] worklog\n" };
    if (key.startsWith("git config --get user.name"))
      return { ok: true, code: 0, stdout: "Raj D\n" };
    if (key.startsWith("git config --get user.email"))
      return { ok: true, code: 0, stdout: "raj@example.com\n" };
    if (key.startsWith("gh api user")) return { ok: true, code: 0, stdout: "radroid\n" };
    return { ok: false, code: 127, stderr: "not found" };
  });
}

/** A fake `lib/bundle.mjs`: `collect(options)` → bundle, recording what the CLI passed. */
function fakeBundle(bundle = BUNDLE) {
  const calls = [];
  return {
    calls,
    module: {
      collect: async (options) => {
        calls.push(options);
        return bundle;
      },
    },
  };
}

/** A fake `lib/summary.mjs`: `renderSummary(bundle)` → text, recording what it was handed. */
function fakeSummary(render = (bundle) => `SUMMARY ${bundle.range.from}`) {
  const calls = [];
  return {
    calls,
    module: {
      renderSummary: (bundle) => {
        calls.push(bundle);
        return render(bundle);
      },
    },
  };
}

/** A fake `lib/extract.mjs` recording the queue options, the raw payload text and the commit. */
function fakeExtract(overrides = {}) {
  const queued = [];
  const parsed = [];
  const committed = [];
  return {
    queued,
    parsed,
    committed,
    module: {
      queue: (options) => {
        queued.push(options);
        return {
          queued: [
            {
              sessionKey: "t3-abc",
              title: "Sync fork with upstream",
              slicePath: "/tmp/slices/t3-abc.md",
              reason: "11 new events",
              newEvents: 11,
            },
          ],
          skipped: [{ sessionKey: "cc-def", reason: "linked to a T3code thread" }],
          warnings: [],
        };
      },
      parseExtractPayload: (raw) => {
        parsed.push(raw);
        return JSON.parse(raw);
      },
      commitExtract: (options) => {
        committed.push(options);
        return {
          file: "/tmp/extracts/t3-abc.json",
          document: { sessionKey: "t3-abc", cursor: { lastEventAt: "2026-08-10T18:00:00.000Z" } },
        };
      },
      ...overrides,
    },
  };
}

/** A fake `lib/init.mjs`: `init({root, deps})` → the merge report the CLI renders. */
function fakeInit(result = {}) {
  const calls = [];
  return {
    calls,
    module: {
      init: async (options) => {
        calls.push(options);
        return {
          root: "",
          created: [],
          existed: [],
          discovered: [],
          added: [],
          updated: [],
          unchanged: [],
          registryPath: "",
          warnings: [],
          gitInitialized: false,
          ...result,
        };
      },
    },
  };
}

function parseJson(text) {
  return JSON.parse(text);
}

// One test in this file drives publish against REAL git, because a fake runner cannot see the
// difference between a pathspec git accepts and one it calls fatal — and that difference is what
// makes `git commit -- <paths>` safe to use. It is skipped where git is absent.
const GIT_AVAILABLE = (() => {
  try {
    const probe = NodeChildProcess.spawnSync("git", ["--version"], { encoding: "utf8" });
    return probe.error == null && probe.status === 0;
  } catch {
    return false;
  }
})();

/** Runs git in the fixture repo, ignoring the developer's own git config. */
function git(cwd, args) {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: NodeOS.devNull,
      GIT_CONFIG_SYSTEM: NodeOS.devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.error != null || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.error?.message}`);
  }
  return result.stdout;
}

/** Writes config/redaction.yaml in the sandbox, in the subset lib/yamlLite.mjs accepts. */
function writeRedaction(root, alwaysRedact, replacements = {}) {
  const lines = ["version: 1", "always_redact:"];
  for (const term of alwaysRedact) lines.push(`  - ${term}`);
  lines.push("replacements:");
  for (const [term, replacement] of Object.entries(replacements))
    lines.push(`  ${term}: ${replacement}`);
  const file = NodePath.join(root, "config", "redaction.yaml");
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

/** Writes config/projects.yaml verbatim — including deliberately broken YAML. */
function writeRegistry(root, text) {
  const file = NodePath.join(root, "config", "projects.yaml");
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, text, "utf8");
  return file;
}

/** Overwrites the sandbox bundle with one that reports an unclassified project. */
function writeBundleWithUnclassified(bundlePath, entry) {
  NodeFS.writeFileSync(bundlePath, JSON.stringify({ ...BUNDLE, unclassified: [entry] }), "utf8");
  return bundlePath;
}

// --- usage, help and dispatch ---------------------------------------------------------------------

NodeTest.test("a bare invocation prints the map of commands and exits 0", async (t) => {
  scenario(t);
  const result = await runCli([]);
  NodeAssert.equal(result.code, 0);
  NodeAssert.deepEqual(result.exits, [0]);
  for (const command of commandCatalogue())
    NodeAssert.match(result.out, new RegExp(`\\b${command.name}\\b`));
  NodeAssert.match(result.out, /Exit codes:/u);
});

NodeTest.test("an unknown command is a usage error naming the valid ones", async (t) => {
  scenario(t);
  const result = await runCli(["collct"]);
  NodeAssert.equal(result.code, 2);
  NodeAssert.match(result.err, /Unknown command "collct"/u);
  NodeAssert.match(result.err, /doctor, init, projects, collect/u);
});

NodeTest.test("--help works for every command, and lists its own flags", async (t) => {
  scenario(t);
  for (const command of commandCatalogue()) {
    const result = await runCli([command.name, "--help"]);
    NodeAssert.equal(result.code, 0, `${command.name} --help should exit 0`);
    NodeAssert.match(result.out, /Usage:/u);
    NodeAssert.match(result.out, new RegExp(`worklog ${command.name}`));
    NodeAssert.match(result.out, /--json/u);
  }
});

NodeTest.test("-h wins wherever it appears, even after other flags", async (t) => {
  const box = scenario(t);
  const result = await runCli(["collect", "--from", DAY, "--root", box.root, "-h"]);
  NodeAssert.equal(result.code, 0);
  NodeAssert.match(result.out, /worklog collect —/u);
});

NodeTest.test(
  "`help <command>` prints that command's usage, and an unknown one exits 2",
  async (t) => {
    scenario(t);
    const good = await runCli(["help", "publish"]);
    NodeAssert.equal(good.code, 0);
    NodeAssert.match(good.out, /worklog publish/u);

    const bad = await runCli(["help", "nope"]);
    NodeAssert.equal(bad.code, 2);
    NodeAssert.match(bad.err, /Unknown command "nope"/u);
  },
);

NodeTest.test("an unknown flag names the command and lists the valid flags", async (t) => {
  scenario(t);
  const result = await runCli(["collect", "--form", DAY]);
  NodeAssert.equal(result.code, 2);
  NodeAssert.match(result.err, /Unknown flag "--form" for `worklog collect`/u);
  NodeAssert.match(result.err, /--from/u);
  NodeAssert.match(result.err, /--json/u);
  NodeAssert.match(result.err, /Try `worklog collect --help`/u);
});

NodeTest.test("a short flag that is not -h is rejected rather than guessed at", async (t) => {
  scenario(t);
  const result = await runCli(["lint", "-f", "x.md"]);
  NodeAssert.equal(result.code, 2);
  NodeAssert.match(result.err, /Unknown flag "-f"/u);
});

NodeTest.test("flag values: --flag=value works, and a missing value is an error", async (t) => {
  const box = scenario(t);
  const inline = await runCli(["lint", `--file=${box.dayFile}`, "--root", box.root]);
  NodeAssert.equal(inline.code, 0);

  const missing = await runCli(["collect", "--from"]);
  NodeAssert.equal(missing.code, 2);
  NodeAssert.match(missing.err, /--from needs a value/u);

  // A value that looks like a flag must be given with `=`, so a typo cannot eat the next flag.
  const swallowed = await runCli(["publish", "--date", DAY, "--message", "--dry-run"]);
  NodeAssert.equal(swallowed.code, 2);
  NodeAssert.match(swallowed.err, /--message needs a value/u);
});

NodeTest.test("bad flag values are refused with the allowed set", async (t) => {
  const box = scenario(t);
  const gap = await runCli(["collect", "--from", DAY, "--gap", "soon", "--root", box.root]);
  NodeAssert.equal(gap.code, 2);
  NodeAssert.match(gap.err, /--gap must be a whole number/u);

  const print = await runCli(["collect", "--from", DAY, "--print", "verbose", "--root", box.root]);
  NodeAssert.equal(print.code, 2);
  NodeAssert.match(print.err, /summary \| json \| both/u);

  const allow = await runCli([
    "lint",
    "--file",
    box.dayFile,
    "--allow",
    "no-such-rule",
    "--root",
    box.root,
  ]);
  NodeAssert.equal(allow.code, 2);
  NodeAssert.match(allow.err, /Unknown rule "no-such-rule"/u);
  NodeAssert.match(allow.err, /secret-shape/u);
});

NodeTest.test("a missing required flag is a usage error", async (t) => {
  scenario(t);
  const collect = await runCli(["collect"]);
  NodeAssert.equal(collect.code, 2);
  NodeAssert.match(collect.err, /`worklog collect` needs --from/u);

  const lint = await runCli(["lint"]);
  NodeAssert.equal(lint.code, 2);
  NodeAssert.match(lint.err, /needs --file/u);
});

NodeTest.test("a bare argument is never silently ignored", async (t) => {
  scenario(t);
  const result = await runCli(["collect", DAY]);
  NodeAssert.equal(result.code, 2);
  NodeAssert.match(result.err, /takes no bare arguments — got "2026-08-10"/u);
});

NodeTest.test("dates are validated before anything is read", async (t) => {
  const box = scenario(t);
  const malformed = await runCli(["collect", "--from", "10-08-2026", "--root", box.root]);
  NodeAssert.equal(malformed.code, 2);
  NodeAssert.match(malformed.err, /YYYY-MM-DD/u);

  const impossible = await runCli(["collect", "--from", "2026-02-31", "--root", box.root]);
  NodeAssert.equal(impossible.code, 2);
  NodeAssert.match(impossible.err, /not a real calendar date/u);

  const backwards = await runCli([
    "collect",
    "--from",
    DAY,
    "--to",
    "2026-08-01",
    "--root",
    box.root,
  ]);
  NodeAssert.equal(backwards.code, 2);
  NodeAssert.match(backwards.err, /before its start/u);
});

// --- collect --------------------------------------------------------------------------------------

NodeTest.test(
  "collect calls lib/bundle.mjs collect(), writes the bundle and echoes its path last",
  async (t) => {
    const box = scenario(t);
    const bundle = fakeBundle();
    const summary = fakeSummary();
    const run = repoRun(box.root);
    const now = new Date("2026-08-10T21:00:00.000Z");
    const expected = NodePath.join(
      box.root,
      ".worklog-tmp",
      "bundles",
      `bundle-${DAY}_${DAY}.json`,
    );
    NodeFS.rmSync(expected, { force: true });

    const result = await runCli(["collect", "--from", DAY, "--root", box.root], {
      deps: { bundle: bundle.module, summary: summary.module, run, now: () => now },
    });

    NodeAssert.equal(result.code, 0);
    NodeAssert.equal(bundle.calls.length, 1);
    const call = bundle.calls[0];
    NodeAssert.equal(call.from, DAY);
    NodeAssert.equal(call.to, DAY);
    NodeAssert.equal(call.worklogRoot, box.root);
    NodeAssert.equal(call.includeGit, true);
    NodeAssert.equal(call.gapMinutes, 30);
    NodeAssert.equal(call.now, now, "the collector must be given the CLI's clock, not its own");
    NodeAssert.equal(call.run, run, "one shell runner for the whole process");

    // Rendering is lib/summary.mjs's job, and it renders the bundle the collector just returned.
    NodeAssert.equal(summary.calls.length, 1);
    NodeAssert.deepEqual(summary.calls[0], BUNDLE);

    const lines = result.out.trimEnd().split("\n");
    NodeAssert.equal(lines.at(-1), `bundle: ${expected}`);
    NodeAssert.match(result.out, /SUMMARY 2026-08-10/u);
    NodeAssert.deepEqual(JSON.parse(NodeFS.readFileSync(expected, "utf8")), BUNDLE);
  },
);

NodeTest.test("collect --print honours summary, json and both", async (t) => {
  const box = scenario(t);
  const bundle = fakeBundle();
  const summary = fakeSummary();

  const rendered = await runCli(
    ["collect", "--from", DAY, "--print", "summary", "--root", box.root],
    {
      deps: { bundle: bundle.module, summary: summary.module },
    },
  );
  NodeAssert.equal(rendered.code, 0);
  NodeAssert.match(rendered.out, /SUMMARY/u);
  NodeAssert.doesNotMatch(rendered.out, /^bundle: /mu);

  const json = await runCli(["collect", "--from", DAY, "--print", "json", "--root", box.root], {
    deps: { bundle: bundle.module, summary: summary.module },
  });
  NodeAssert.equal(json.code, 0);
  NodeAssert.deepEqual(parseJson(json.out), BUNDLE);
  NodeAssert.equal(
    summary.calls.length,
    1,
    "--print json must not pay to render a summary nobody reads",
  );
});

NodeTest.test(
  "collect passes --gap and --no-git through, and covers a multi-day range",
  async (t) => {
    const box = scenario(t);
    const bundle = fakeBundle();
    const argv = [
      "collect",
      "--from",
      "2026-08-08",
      "--to",
      DAY,
      "--gap",
      "45",
      "--no-git",
      "--root",
      box.root,
    ];
    const result = await runCli(argv, {
      deps: { bundle: bundle.module, summary: fakeSummary().module },
    });

    NodeAssert.equal(result.code, 0);
    NodeAssert.equal(bundle.calls[0].from, "2026-08-08");
    NodeAssert.equal(bundle.calls[0].to, DAY);
    NodeAssert.equal(bundle.calls[0].gapMinutes, 45);
    NodeAssert.equal(bundle.calls[0].includeGit, false);
    NodeAssert.match(result.out, /bundle: .*bundle-2026-08-08_2026-08-10\.json/u);

    // The day list is the CLI's own expansion of [from, to] and rides in the JSON envelope.
    const json = await runCli([...argv, "--json"], {
      deps: { bundle: bundle.module, summary: fakeSummary().module },
    });
    const payload = parseJson(json.out);
    NodeAssert.deepEqual(payload.range, {
      from: "2026-08-08",
      to: DAY,
      days: ["2026-08-08", "2026-08-09", DAY],
    });
    NodeAssert.equal(payload.gapMinutes, 45);
    NodeAssert.equal(payload.includeGit, false);
  },
);

NodeTest.test(
  "collect prints lib/summary.mjs's rendering verbatim, then the bundle path",
  async (t) => {
    const box = scenario(t);
    const bundle = fakeBundle();
    const expected = NodePath.join(
      box.root,
      ".worklog-tmp",
      "bundles",
      `bundle-${DAY}_${DAY}.json`,
    );
    NodeFS.rmSync(expected, { force: true });

    // No `summary` fake on purpose: the real lib/summary.mjs must be the thing that renders, and a
    // module that cannot render is a crash — there is no fallback digest to fall back to.
    const result = await runCli(["collect", "--from", DAY, "--print", "both", "--root", box.root], {
      deps: { bundle: bundle.module, run: repoRun(box.root) },
    });

    NodeAssert.equal(result.code, 0);
    const rendered = renderSummary(BUNDLE);
    // Guard the guard: a thin or empty digest would make the comparison below vacuous. This says
    // "the digest is real", not "the digest is shaped like this" — its wording is summary.test.mjs's.
    NodeAssert.ok(
      rendered.split("\n").length > 8,
      `the digest fixture should be substantial:\n${rendered}`,
    );
    NodeAssert.match(rendered, /2026-08-10/u);
    NodeAssert.match(rendered, /Sync fork with upstream/u);

    const lines = result.out.split("\n");
    const digest = rendered.split("\n");
    NodeAssert.equal(
      lines.slice(0, digest.length).join("\n"),
      rendered,
      "the digest must be reproduced verbatim",
    );
    NodeAssert.equal(lines.at(-1), "", "stdout ends with a newline");
    NodeAssert.equal(
      lines.at(-2),
      `bundle: ${expected}`,
      "the skill reads the path off the tail of stdout",
    );
    // Between the digest and that last line there is nothing but warnings.
    for (const line of lines.slice(digest.length, -2)) NodeAssert.match(line, /^warning: /u);

    NodeAssert.deepEqual(JSON.parse(NodeFS.readFileSync(expected, "utf8")), BUNDLE);
  },
);

// --- lint -----------------------------------------------------------------------------------------

NodeTest.test("lint exits 0 on a clean file and 1 on a leak", async (t) => {
  const box = scenario(t);
  const clean = await runCli(["lint", "--file", box.dayFile, "--root", box.root]);
  NodeAssert.equal(clean.code, 0);
  NodeAssert.match(clean.out, /No redaction findings\./u);

  const leaky = NodePath.join(box.root, "days", "2026-08-09.md");
  NodeFS.writeFileSync(leaky, LEAKY_DAY_FILE, "utf8");
  const dirty = await runCli(["lint", "--file", leaky, "--root", box.root]);
  NodeAssert.equal(dirty.code, 1);
  NodeAssert.deepEqual(dirty.exits, [1]);
  NodeAssert.match(dirty.out, /secret-shape/u);
  // The excerpt must not reprint the thing it is complaining about.
  NodeAssert.doesNotMatch(dirty.out, /sk-abcdefghijklmnopqrst/u);
});

NodeTest.test("lint --allow suppresses a rule by id", async (t) => {
  const box = scenario(t);
  const leaky = NodePath.join(box.root, "days", "2026-08-09.md");
  NodeFS.writeFileSync(leaky, LEAKY_DAY_FILE, "utf8");

  const allowed = await runCli([
    "lint",
    "--file",
    leaky,
    "--allow",
    "secret-shape",
    "--root",
    box.root,
  ]);
  NodeAssert.equal(allowed.code, 0);
  NodeAssert.match(allowed.out, /No redaction findings\./u);
});

NodeTest.test("a registry that cannot be parsed makes the gate refuse, not pass", async (t) => {
  const box = scenario(t);
  // A tab is all it takes, and the README invites hand edits. Before this, the gate treated an
  // unparseable registry as an empty one: private-project and private-branch stopped firing,
  // `lint` exited 0 and `publish` committed.
  writeRegistry(box.root, "version: 1\nprojects:\n\tacme:\n\t\tinclude: true\n");
  const run = repoRun(box.root);

  const lint = await runCli(["lint", "--file", box.dayFile, "--root", box.root]);
  NodeAssert.equal(lint.code, 1);
  NodeAssert.match(lint.err, /The redaction gate cannot run/u);
  NodeAssert.match(lint.err, /config\/projects\.yaml/u);
  NodeAssert.match(lint.err, /tabs are not allowed/u, "the parse error itself must be quoted");
  NodeAssert.match(lint.err, /move it aside/u, "a refusal has to say how to proceed");

  const publish = await runCli(["publish", "--date", DAY, "--root", box.root], { deps: { run } });
  NodeAssert.equal(publish.code, 1);
  NodeAssert.match(publish.err, /The redaction gate cannot run/u);
  NodeAssert.deepEqual(run.calls, [], "nothing may be staged when the gate could not be evaluated");

  const asJson = await runCli(["lint", "--json", "--file", box.dayFile, "--root", box.root]);
  NodeAssert.equal(asJson.code, 1);
  const payload = parseJson(asJson.out);
  NodeAssert.equal(payload.ok, false);
  NodeAssert.equal(payload.registry, NodePath.join(box.root, "config", "projects.yaml"));
});

NodeTest.test("a registry that is merely absent still lints, with a warning", async (t) => {
  const box = scenario(t);
  // The pre-`init` state is not a broken state: there is nothing to evaluate yet, so the run is
  // honest about what it skipped and carries on.
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(box.root, "config", "projects.yaml")), false);
  const result = await runCli(["lint", "--file", box.dayFile, "--root", box.root]);
  NodeAssert.equal(result.code, 0);
  NodeAssert.match(result.out, /warning: No project registry at/u);
});

NodeTest.test(
  "lint --bundle checks the names of projects the registry has never heard of",
  async (t) => {
    const box = scenario(t);
    writeBundleWithUnclassified(box.bundlePath, {
      key: "acme-billing",
      displayName: "Acme Billing",
      roots: [NodePath.join(box.dir, "Developer", "acme-billing")],
      evidence: { sessions: 2 },
    });
    NodeFS.writeFileSync(box.dayFile, "# 2026-08-10\n\nSpent the day in Acme Billing.\n", "utf8");

    const withBundle = await runCli([
      "lint",
      "--json",
      "--file",
      box.dayFile,
      "--bundle",
      box.bundlePath,
      "--root",
      box.root,
    ]);
    const payload = parseJson(withBundle.out);
    // The key, the display name and the root basename all go in; the basename repeats the key, so
    // two distinct terms survive.
    NodeAssert.equal(payload.unclassifiedTerms, 2);
    NodeAssert.equal(withBundle.code, 1, "an unclassified project name is a blocking finding");
    NodeAssert.ok(
      payload.findings.some((finding) => finding.rule === "unclassified-project"),
      `expected an unclassified-project finding, got ${JSON.stringify(payload.findings)}`,
    );

    // Without the bundle the same file passes — which is exactly why the weaker run has to say so.
    const without = await runCli(["lint", "--json", "--file", box.dayFile, "--root", box.root]);
    const bare = parseJson(without.out);
    NodeAssert.equal(bare.unclassifiedTerms, 0);
    NodeAssert.ok(
      bare.warnings.some((warning) => warning.includes("No --bundle given")),
      `expected a warning about the missing bundle, got ${JSON.stringify(bare.warnings)}`,
    );
  },
);

NodeTest.test(
  "lint --bundle rejects a bundle path it cannot read rather than checking less",
  async (t) => {
    const box = scenario(t);
    const result = await runCli([
      "lint",
      "--file",
      box.dayFile,
      "--bundle",
      "nope.json",
      "--root",
      box.root,
    ]);
    NodeAssert.equal(result.code, 2);
    NodeAssert.match(result.err, /No bundle at nope\.json/u);
  },
);

NodeTest.test("lint on an unreadable file fails closed", async (t) => {
  const box = scenario(t);
  const result = await runCli([
    "lint",
    "--file",
    NodePath.join(box.root, "days", "nope.md"),
    "--root",
    box.root,
  ]);
  NodeAssert.equal(result.code, 1);
  NodeAssert.match(result.out, /lint-unavailable/u);
});

// --- publish --------------------------------------------------------------------------------------

NodeTest.test("publish commits the day file and never pushes", async (t) => {
  const box = scenario(t);
  const run = repoRun(box.root);
  const result = await runCli(["publish", "--date", DAY, "--root", box.root], { deps: { run } });

  NodeAssert.equal(result.code, 0);
  const commit = run.calls.find((call) => call.key.startsWith("git commit"));
  NodeAssert.ok(commit, "expected a git commit");
  // The pathspec is not cosmetic: without it, anything the human had already staged in the worklog
  // repo is swept into a commit that only `staged` was ever linted for.
  NodeAssert.deepEqual(commit.args, [
    "commit",
    "-m",
    `worklog: ${DAY}`,
    "--",
    "days/2026-08-10.md",
  ]);
  NodeAssert.equal(commit.cwd, box.root);
  NodeAssert.ok(run.calls.some((call) => call.key.startsWith("git add -- days/2026-08-10.md")));
  NodeAssert.ok(!run.calls.some((call) => call.key.includes("push")), "publish must never push");
  NodeAssert.match(result.out, /Committed days\/2026-08-10\.md as abc1234/u);
});

NodeTest.test("publish --message overrides the commit message", async (t) => {
  const box = scenario(t);
  const run = repoRun(box.root);
  await runCli(["publish", "--date", DAY, "--message", "log: the gate", "--root", box.root], {
    deps: { run },
  });
  const commit = run.calls.find((call) => call.key.startsWith("git commit"));
  NodeAssert.deepEqual(commit.args, ["commit", "-m", "log: the gate", "--", "days/2026-08-10.md"]);
});

NodeTest.test(
  "publish commits the staged paths git resolved, never a bare index sweep",
  async (t) => {
    const box = scenario(t);
    // config/ and extracts/ exist, so `git add` is asked for all three — but the commit may only
    // name paths git actually knows: `git commit -- extracts` is fatal while that directory is
    // still empty, which it is until the first extract lands. So the pathspec comes from what the
    // diff reported, and nothing a human staged by hand is in it.
    NodeFS.mkdirSync(NodePath.join(box.root, "config"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(box.root, "extracts"), { recursive: true });
    const diffKey = `git diff --cached --name-only --no-renames -z -- days/${DAY}.md config extracts`;
    const run = repoRun(box.root, {
      [diffKey]: {
        ok: true,
        code: 0,
        stdout: `days/${DAY}.md\0config/projects.yaml\0`,
      },
    });

    const result = await runCli(["publish", "--date", DAY, "--root", box.root], { deps: { run } });
    NodeAssert.equal(result.code, 0);

    const add = run.calls.find((call) => call.key.startsWith("git add"));
    NodeAssert.deepEqual(add.args, ["add", "--", `days/${DAY}.md`, "config", "extracts"]);

    const commit = run.calls.find((call) => call.key.startsWith("git commit"));
    NodeAssert.deepEqual(commit.args, [
      "commit",
      "-m",
      `worklog: ${DAY}`,
      "--",
      `days/${DAY}.md`,
      "config/projects.yaml",
    ]);
  },
);

NodeTest.test("publish refuses when the day file has findings, before touching git", async (t) => {
  const box = scenario(t);
  NodeFS.writeFileSync(box.dayFile, LEAKY_DAY_FILE, "utf8");
  const run = repoRun(box.root);

  const result = await runCli(["publish", "--date", DAY, "--root", box.root], { deps: { run } });
  NodeAssert.equal(result.code, 1);
  NodeAssert.match(result.err, /Refusing to publish days\/2026-08-10\.md/u);
  NodeAssert.match(result.out, /secret-shape/u);
  NodeAssert.deepEqual(run.calls, [], "nothing should be staged when the gate fails");
});

NodeTest.test("publish refuses politely when the day file does not exist", async (t) => {
  const box = scenario(t);
  const run = repoRun(box.root);
  const result = await runCli(["publish", "--date", "2026-08-09", "--root", box.root], {
    deps: { run },
  });

  NodeAssert.equal(result.code, 1);
  NodeAssert.match(result.err, /Nothing to publish: days\/2026-08-09\.md does not exist yet\./u);
  NodeAssert.doesNotMatch(result.err, /Error:/u);
  NodeAssert.deepEqual(run.calls, []);
});

NodeTest.test("publish refuses when nothing changed", async (t) => {
  const box = scenario(t);
  // An empty `git diff --cached --name-only` means the index matches HEAD.
  const diffKey = `git diff --cached --name-only --no-renames -z -- days/${DAY}.md`;
  const run = repoRun(box.root, { [diffKey]: { ok: true, code: 0, stdout: "" } });
  const result = await runCli(["publish", "--date", DAY, "--root", box.root], { deps: { run } });

  NodeAssert.equal(result.code, 1);
  NodeAssert.match(result.err, /Nothing to commit/u);
  NodeAssert.ok(!run.calls.some((call) => call.key.startsWith("git commit")));

  // A git that fails outright is a different answer from "nothing changed", and must not commit.
  const broken = repoRun(box.root, {
    [diffKey]: { ok: false, code: 128, stderr: "fatal: not a git repository\n" },
  });
  const failed = await runCli(["publish", "--date", DAY, "--root", box.root], {
    deps: { run: broken },
  });
  NodeAssert.equal(failed.code, 1);
  NodeAssert.match(failed.err, /Could not inspect the worklog index/u);
  NodeAssert.ok(!broken.calls.some((call) => call.key.startsWith("git commit")));
});

NodeTest.test("publish --dry-run reports without staging", async (t) => {
  const box = scenario(t);
  const run = repoRun(box.root);
  const result = await runCli(["publish", "--date", DAY, "--dry-run", "--root", box.root], {
    deps: { run },
  });

  NodeAssert.equal(result.code, 0);
  NodeAssert.match(result.out, /Dry run/u);
  NodeAssert.match(result.out, /would commit: worklog: 2026-08-10/u);
  NodeAssert.ok(!run.calls.some((call) => call.key.startsWith("git add")));
  NodeAssert.ok(!run.calls.some((call) => call.key.startsWith("git commit")));
});

NodeTest.test(
  "against real git, publish commits only the cleared file and leaves a hand-staged one behind",
  async (t) => {
    if (!GIT_AVAILABLE) return t.skip("git is not available");
    const box = scenario(t);
    withEnv(t, {
      GIT_CONFIG_GLOBAL: NodeOS.devNull,
      GIT_CONFIG_SYSTEM: NodeOS.devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
    git(box.root, ["init", "-q", "-b", "main", "."]);
    git(box.root, ["config", "user.name", "Raj D"]);
    git(box.root, ["config", "user.email", "raj@example.com"]);
    git(box.root, ["config", "commit.gpgsign", "false"]);

    writeRegistry(
      box.root,
      "version: 1\nidentities:\n  - Raj D\nprojects:\n  worklog:\n    display_name: Worklog\n    roots:\n      - /nonexistent/worklog\n    include: true\n    visibility: public\n    confirmed: true\n",
    );
    // Empty on purpose: `extracts/` exists from `worklog init` and stays empty until the first
    // extract lands. `git add -- extracts` shrugs; `git commit -- extracts` is fatal.
    NodeFS.mkdirSync(NodePath.join(box.root, "extracts"), { recursive: true });

    const leaky = NodePath.join(box.root, "days", "2026-08-09.md");
    NodeFS.writeFileSync(leaky, LEAKY_DAY_FILE, "utf8");
    git(box.root, ["add", "--", "days/2026-08-09.md"]);

    // No injected runner: this is the real lib/git.mjs runner talking to the real git.
    const result = await runCli(["publish", "--date", DAY, "--root", box.root]);
    NodeAssert.equal(result.code, 0, result.all);

    const committed = git(box.root, ["show", "--name-only", "--format=", "HEAD"])
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .sort();
    NodeAssert.deepEqual(committed, ["config/projects.yaml", `days/${DAY}.md`]);
    // The leak the human staged by hand never passed the gate, so it is still sitting in the index.
    NodeAssert.match(git(box.root, ["status", "--porcelain"]), /^A {2}days\/2026-08-09\.md$/mu);
  },
);

NodeTest.test(
  "publish finds the day's bundle itself and refuses on an unclassified project name",
  async (t) => {
    const box = scenario(t);
    writeBundleWithUnclassified(box.bundlePath, {
      key: "acme-billing",
      displayName: "Acme Billing",
      roots: [NodePath.join(box.dir, "Developer", "acme-billing")],
    });
    const run = repoRun(box.root);

    // Nobody publishing a day file is going to remember a --bundle flag, so publish locates
    // .worklog-tmp/bundles/bundle-<date>_<date>.json on its own.
    const clean = await runCli(
      ["publish", "--json", "--date", DAY, "--dry-run", "--root", box.root],
      { deps: { run } },
    );
    NodeAssert.equal(clean.code, 0);
    NodeAssert.equal(parseJson(clean.out).unclassifiedTerms, 2);

    NodeFS.writeFileSync(box.dayFile, "# 2026-08-10\n\nShipped Acme Billing's importer.\n", "utf8");
    const leaky = await runCli(["publish", "--date", DAY, "--root", box.root], { deps: { run } });
    NodeAssert.equal(leaky.code, 1);
    NodeAssert.match(leaky.out, /unclassified-project/u);
    NodeAssert.ok(!run.calls.some((call) => call.key.startsWith("git commit")));
  },
);

NodeTest.test("publish says so when the day's bundle is missing or unreadable", async (t) => {
  const box = scenario(t);
  const run = repoRun(box.root);

  NodeFS.rmSync(box.bundlePath, { force: true });
  const missing = await runCli(
    ["publish", "--json", "--date", DAY, "--dry-run", "--root", box.root],
    { deps: { run } },
  );
  NodeAssert.equal(missing.code, 0);
  const missingPayload = parseJson(missing.out);
  NodeAssert.equal(missingPayload.unclassifiedTerms, 0);
  NodeAssert.ok(
    missingPayload.warnings.some((warning) => warning.includes("No evidence bundle at")),
    `expected a warning naming the bundle it looked for, got ${JSON.stringify(missingPayload.warnings)}`,
  );

  // A corrupt bundle is the same story: quieter checking is never allowed to be silent.
  NodeFS.writeFileSync(box.bundlePath, "{ not json", "utf8");
  const corrupt = await runCli(
    ["publish", "--json", "--date", DAY, "--dry-run", "--root", box.root],
    { deps: { run } },
  );
  NodeAssert.equal(corrupt.code, 0);
  NodeAssert.ok(
    parseJson(corrupt.out).warnings.some((warning) =>
      warning.includes("Could not read the evidence bundle"),
    ),
  );
});

NodeTest.test("publish --range looks for the range's own bundle", async (t) => {
  const box = scenario(t);
  const label = `2026-08-04..${DAY}`;
  NodeFS.mkdirSync(NodePath.join(box.root, "ranges"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(box.root, "ranges", `${label}.md`),
    "# The week\n\nShipped Acme Billing's importer.\n",
    "utf8",
  );
  writeBundleWithUnclassified(
    NodePath.join(box.root, ".worklog-tmp", "bundles", `bundle-2026-08-04_${DAY}.json`),
    { key: "acme-billing", displayName: "Acme Billing", roots: [] },
  );

  const result = await runCli(["publish", "--range", label, "--root", box.root], {
    deps: { run: repoRun(box.root) },
  });
  NodeAssert.equal(result.code, 1);
  NodeAssert.match(result.out, /unclassified-project/u);
});

NodeTest.test("publish refuses when the worklog root is not a git repo", async (t) => {
  const box = scenario(t);
  const run = repoRun(box.root, {
    "git rev-parse --is-inside-work-tree": { ok: false, code: 128 },
  });
  const result = await runCli(["publish", "--date", DAY, "--root", box.root], { deps: { run } });

  NodeAssert.equal(result.code, 1);
  NodeAssert.match(result.err, /is not a git repository/u);
});

// --- doctor ---------------------------------------------------------------------------------------

NodeTest.test("doctor exits 0 when nothing at all is installed", async (t) => {
  const box = sandbox(t);
  withEnv(t, {
    WORKLOG_T3_BASE_DIRS: NodePath.join(box.dir, "absent"),
    WORKLOG_CLAUDE_PROJECTS: NodePath.join(box.dir, "absent-too"),
  });
  const result = await runCli(["doctor", "--root", box.root], { deps: { run: makeRun() } });

  NodeAssert.equal(result.code, 0, "doctor must never fail the caller");
  NodeAssert.deepEqual(result.exits, [0]);
  NodeAssert.match(result.out, /No ~\/\.t3 state directory found/u);
  NodeAssert.match(result.out, /Claude Code logs.*not found/u);
  NodeAssert.match(result.out, /Worklog repo.*worklog init/u);
  NodeAssert.match(result.out, /`gh` is not installed/u);
  NodeAssert.match(result.out, /Git identity.*Not configured/u);
  NodeAssert.match(result.out, /warnings\./u);
});

NodeTest.test(
  "doctor reports database row counts, session files, git identity and gh auth",
  async (t) => {
    const box = scenario(t);
    const result = await runCli(["doctor", "--root", box.root], {
      deps: {
        run: repoRun(box.root, {
          "gh --version": { ok: true, code: 0, stdout: "gh version 2.97.0\n" },
          "gh auth status": { ok: true, code: 0 },
        }),
        inspectDatabases: () => ({
          databases: [
            {
              baseDir: box.t3,
              dbPath: NodePath.join(box.t3, "state.sqlite"),
              exists: true,
              ok: true,
              counts: {
                projection_projects: 12,
                projection_threads: 83,
                projection_turns: 555,
                projection_thread_activities: 102_126,
                projection_thread_messages: 5469,
              },
            },
          ],
          warnings: [],
        }),
        listSessionFiles: () => Array.from({ length: 476 }, () => ({ file: "x.jsonl" })),
      },
    });

    NodeAssert.equal(result.code, 0);
    NodeAssert.match(result.out, /12 projects, 83 threads, 555 turns, 102,126 activities/u);
    NodeAssert.match(result.out, /476 session files/u);
    NodeAssert.match(result.out, /Worklog repo.*git repo/u);
    NodeAssert.match(result.out, /Raj D <raj@example\.com>/u);
    NodeAssert.match(result.out, /gh version 2\.97\.0 — authenticated/u);
    NodeAssert.match(result.out, /Timezone/u);
    // The home directory must never be spelled out in full.
    NodeAssert.doesNotMatch(
      result.out,
      new RegExp(box.dir.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
    );
  },
);

NodeTest.test("doctor still exits 2 when a flag is misused", async (t) => {
  const box = sandbox(t);
  const result = await runCli(["doctor", "--roots", box.root]);
  NodeAssert.equal(result.code, 2);
  NodeAssert.match(result.err, /Unknown flag "--roots"/u);
});

// --- init and projects ------------------------------------------------------------------------------

NodeTest.test(
  "init delegates the whole job to lib/init.mjs and renders what it added",
  async (t) => {
    const box = sandbox(t);
    const run = repoRun(box.root);
    const registryPath = NodePath.join(box.root, "config", "projects.yaml");
    const init = fakeInit({
      root: box.root,
      created: [box.root, NodePath.join(box.root, "days"), registryPath],
      discovered: [
        {
          key: "t3-code-fork",
          displayName: "T3 Code (fork)",
          roots: [NodePath.join(box.dir, "Developer", "t3code")],
        },
        {
          key: "client-x",
          displayName: "Client X",
          roots: [NodePath.join(box.dir, "Developer", "client-x")],
        },
        // Already in the registry, so it is not a proposal — it must not be advertised as one.
        {
          key: "inbox-lens",
          displayName: "Inbox Lens",
          roots: [NodePath.join(box.dir, "Developer", "inbox-lens")],
        },
      ],
      added: ["t3-code-fork", "client-x"],
      updated: ["inbox-lens"],
      registryPath,
      warnings: [
        "`gh` is not installed, so no pull requests were counted.",
        "No worklog repo yet — run `worklog init` to create one.",
      ],
    });

    const result = await runCli(["init", "--root", box.root], { deps: { init: init.module, run } });

    NodeAssert.equal(result.code, 0);
    NodeAssert.equal(init.calls.length, 1, "the CLI owns none of the scaffolding");
    NodeAssert.deepEqual(Object.keys(init.calls[0]).sort(), ["deps", "root"]);
    NodeAssert.equal(init.calls[0].root, box.root);
    NodeAssert.equal(init.calls[0].deps.run, run, "the library must reuse the CLI's runner");
    NodeAssert.deepEqual(
      Object.keys(init.calls[0].deps),
      ["run"],
      "discovery is on unless --no-discover says otherwise",
    );

    for (const entry of [box.root, NodePath.join(box.root, "days"), registryPath]) {
      NodeAssert.ok(result.out.includes(`    ${entry}`), `init should report creating ${entry}`);
    }
    NodeAssert.match(result.out, /Proposed 2 projects \(all unconfirmed\)/u);
    NodeAssert.match(result.out, /t3-code-fork\s+~\/Developer\/t3code/u);
    NodeAssert.match(result.out, /client-x\s+~\/Developer\/client-x/u);
    NodeAssert.doesNotMatch(result.out, /inbox-lens/u, "an updated project is not a new proposal");
    NodeAssert.match(result.out, /Nothing is named in a report until you set confirmed: true/u);
    NodeAssert.match(result.out, /warning: `gh` is not installed/u);
    // Being told to run the command you just ran is noise, so the CLI drops that one.
    NodeAssert.doesNotMatch(result.out, /warning: .*run `worklog init`/u);

    const payload = parseJson(
      (await runCli(["init", "--json", "--root", box.root], { deps: { init: init.module, run } }))
        .out,
    );
    NodeAssert.deepEqual(payload.added, ["t3-code-fork", "client-x"]);
    NodeAssert.deepEqual(payload.updated, ["inbox-lens"]);
    NodeAssert.deepEqual(
      payload.proposed.map((entry) => entry.key),
      ["t3-code-fork", "client-x"],
    );
    NodeAssert.equal(payload.registryPath, registryPath);
  },
);

NodeTest.test("init --no-discover tells the library to scan nothing", async (t) => {
  const box = sandbox(t);
  const run = repoRun(box.root);
  const init = fakeInit({ root: box.root });

  const result = await runCli(["init", "--root", box.root, "--no-discover"], {
    deps: { init: init.module, run },
  });

  NodeAssert.equal(result.code, 0);
  NodeAssert.deepEqual(init.calls[0].deps.ccSessions, [], "no Claude Code transcript scan");
  NodeAssert.deepEqual(init.calls[0].deps.t3Handles, [], "no T3code database scan");
  NodeAssert.equal(init.calls[0].deps.run, run);
  NodeAssert.match(result.out, /Already set up; nothing to create\./u);
  NodeAssert.doesNotMatch(result.out, /Proposed/u);
});

NodeTest.test(
  "init refuses to overwrite a registry it cannot parse, before calling the library",
  async (t) => {
    const box = sandbox(t);
    NodeFS.mkdirSync(NodePath.join(box.root, "config"), { recursive: true });
    const broken = "projects:\n\tt3code: {a: 1}\n";
    NodeFS.writeFileSync(NodePath.join(box.root, "config", "projects.yaml"), broken, "utf8");
    const init = fakeInit({ root: box.root });

    const result = await runCli(["init", "--root", box.root], {
      deps: { init: init.module, run: makeRun() },
    });

    NodeAssert.equal(result.code, 1);
    NodeAssert.match(result.err, /could not be parsed/u);
    NodeAssert.match(result.err, /init did not touch it/u);
    NodeAssert.equal(
      init.calls.length,
      0,
      "the library must never see a registry the CLI cannot read",
    );
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(box.root, "config", "projects.yaml"), "utf8"),
      broken,
    );
  },
);

NodeTest.test("init seeds identities from git config when the registry has none", async (t) => {
  const box = sandbox(t);
  const run = repoRun(box.root);
  const init = fakeInit({ root: box.root });

  const result = await runCli(["init", "--root", box.root], { deps: { init: init.module, run } });
  NodeAssert.equal(result.code, 0);

  const yaml = NodeFS.readFileSync(NodePath.join(box.root, "config", "projects.yaml"), "utf8");
  NodeAssert.match(yaml, /identities:/u);
  NodeAssert.match(yaml, /^\s+- Raj D$/mu);
  NodeAssert.match(yaml, /^\s+- raj@example\.com$/mu);
  // The GitHub login is seeded alongside them: it is what `mergedPrs` filters on, and without it
  // every PR merged in a repo the user touched would be counted as theirs.
  NodeAssert.match(yaml, /^\s+- "@radroid"$/mu);
  NodeAssert.doesNotMatch(result.out, /warning: No git identity/u);
  NodeAssert.doesNotMatch(result.out, /warning: `gh` could not name/u);

  // A signed-out `gh` still leaves a usable registry — it just cannot attribute pull requests,
  // and says which line to add rather than silently counting everybody's.
  const noGh = NodePath.join(box.dir, "worklog-no-gh");
  const noGhInit = fakeInit({ root: noGh });
  const signedOut = await runCli(["init", "--root", noGh], {
    deps: {
      init: noGhInit.module,
      run: repoRun(noGh, { "gh api user -q .login": { ok: false, code: 1, stderr: "no auth" } }),
    },
  });
  NodeAssert.equal(signedOut.code, 0);
  NodeAssert.match(signedOut.out, /warning: `gh` could not name the signed-in user/u);
  const noGhYaml = NodeFS.readFileSync(NodePath.join(noGh, "config", "projects.yaml"), "utf8");
  NodeAssert.match(noGhYaml, /^\s+- Raj D$/mu);
  NodeAssert.doesNotMatch(noGhYaml, /^\s+- "?@/mu);

  // With no git identity to borrow, the CLI says so instead of inventing one.
  const bare = NodePath.join(box.dir, "worklog-bare");
  const bareInit = fakeInit({ root: bare });
  const nameless = await runCli(["init", "--root", bare], {
    deps: { init: bareInit.module, run: makeRun() },
  });
  NodeAssert.equal(nameless.code, 0);
  NodeAssert.match(nameless.out, /warning: No git identity configured, so `identities:` is empty/u);
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(bare, "config", "projects.yaml")), false);
});

NodeTest.test("init leaves identities that are already in the registry alone", async (t) => {
  const box = sandbox(t);
  NodeFS.mkdirSync(NodePath.join(box.root, "config"), { recursive: true });
  const registryPath = NodePath.join(box.root, "config", "projects.yaml");
  const existing = [
    "version: 1",
    "identities:",
    "  - Someone Else",
    "  - someone@example.com",
    "projects:",
    "  t3code:",
    "    display_name: T3 Code (fork)",
    "    roots: []",
    "    include: true",
    "    visibility: public",
    "    confirmed: true",
    "",
  ].join("\n");
  NodeFS.writeFileSync(registryPath, existing, "utf8");
  const run = repoRun(box.root);
  const init = fakeInit({ root: box.root, registryPath });

  const result = await runCli(["init", "--root", box.root], { deps: { init: init.module, run } });

  NodeAssert.equal(result.code, 0);
  NodeAssert.equal(
    NodeFS.readFileSync(registryPath, "utf8"),
    existing,
    "a registry with identities is never rewritten",
  );
  NodeAssert.ok(
    !run.calls.some((call) => call.key.startsWith("git config --get user")),
    "the registry already answers who the human is, so git is not asked",
  );
});

NodeTest.test("init warns when the worklog root sits inside another git repo", async (t) => {
  const box = sandbox(t);
  // `git rev-parse --show-toplevel` answering with an ancestor means `publish` would commit there.
  const run = repoRun(box.root, {
    "git rev-parse --show-toplevel": { ok: true, code: 0, stdout: `${box.dir}\n` },
  });
  const init = fakeInit({ root: box.root });

  const result = await runCli(["init", "--root", box.root], { deps: { init: init.module, run } });

  NodeAssert.equal(result.code, 0);
  const top = tildify(NodeFS.realpathSync(box.dir));
  NodeAssert.ok(
    result.out.includes(
      `warning: ~/worklog sits inside the git repo at ${top} — commits would land there.`,
    ),
    `expected the nesting warning, got:\n${result.out}`,
  );
});

NodeTest.test("projects lists the registry and anything discovered but unclassified", async (t) => {
  const box = sandbox(t);
  NodeFS.mkdirSync(NodePath.join(box.root, "config"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(box.root, "config", "projects.yaml"),
    [
      "version: 1",
      "projects:",
      "  t3code:",
      "    display_name: T3 Code (fork)",
      "    roots:",
      `      - ${NodePath.join(box.dir, "Developer", "t3code")}`,
      "    include: true",
      "    visibility: public",
      "    confirmed: true",
      "  client-x:",
      "    display_name: Client X",
      "    roots: []",
      "    include: true",
      "    visibility: generic",
      "    confirmed: false",
      "",
    ].join("\n"),
    "utf8",
  );

  const discoverProjects = () => ({
    candidates: [
      { displayName: "T3 Code (fork)", root: NodePath.join(box.dir, "Developer", "t3code") },
      { displayName: "Scratch", root: NodePath.join(box.dir, "Developer", "scratch") },
    ],
    warnings: [],
  });

  const result = await runCli(["projects", "--root", box.root], { deps: { discoverProjects } });
  NodeAssert.equal(result.code, 0);
  NodeAssert.match(result.out, /t3code\s+public/u);
  NodeAssert.match(result.out, /client-x\s+unconfirmed/u);
  NodeAssert.match(result.out, /Discovered but unclassified \(1\)/u);
  NodeAssert.match(result.out, /Scratch/u);

  const skipped = await runCli(["projects", "--root", box.root, "--no-discover"], {
    deps: {
      discoverProjects: () => {
        throw new Error("discovery must not run with --no-discover");
      },
    },
  });
  NodeAssert.equal(skipped.code, 0);
  NodeAssert.doesNotMatch(skipped.out, /unclassified/u);
});

// --- extract ----------------------------------------------------------------------------------------

NodeTest.test(
  "extract-queue resolves a bundle by bare filename and lists the slices",
  async (t) => {
    const box = scenario(t);
    const extract = fakeExtract();
    const result = await runCli(
      ["extract-queue", "--bundle", `bundle-${DAY}_${DAY}.json`, "--root", box.root],
      {
        deps: { extract: extract.module },
      },
    );

    NodeAssert.equal(result.code, 0);
    NodeAssert.equal(extract.queued.length, 1);
    NodeAssert.deepEqual(
      extract.queued[0].bundle,
      BUNDLE,
      "the queue is given the bundle that was read",
    );
    NodeAssert.equal(extract.queued[0].paths.root, box.root);
    NodeAssert.equal(
      extract.queued[0].limit,
      undefined,
      "no --limit means the library's own default",
    );
    // Every field the library reports is rendered: what it was, why it was queued, where it went.
    NodeAssert.match(result.out, /^1 slice written:$/mu);
    NodeAssert.match(result.out, /^\s+Sync fork with upstream$/mu);
    NodeAssert.match(result.out, /^\s+t3-abc — 11 new events$/mu);
    NodeAssert.match(result.out, /^\s+\/tmp\/slices\/t3-abc\.md$/mu);
    NodeAssert.match(result.out, /^1 session\(s\) skipped as immaterial or already current\.$/mu);

    const capped = fakeExtract();
    const limited = await runCli(
      ["extract-queue", "--bundle", box.bundlePath, "--limit", "5", "--root", box.root],
      { deps: { extract: capped.module } },
    );
    NodeAssert.equal(limited.code, 0);
    NodeAssert.equal(capped.queued[0].limit, 5);
  },
);

NodeTest.test("extract-queue hands the always-redact list to the slice writer", async (t) => {
  const box = scenario(t);
  // A slice is the one artefact of this pipeline that reaches another model, and the bundle
  // carries no redaction list — so if the CLI does not read config/redaction.yaml here, every
  // always-redact term is written into the slice verbatim on every real run.
  writeRedaction(box.root, ["Northwind Retail"], { "Northwind Retail": "a retail client" });
  const extract = fakeExtract();

  const result = await runCli(["extract-queue", "--bundle", box.bundlePath, "--root", box.root], {
    deps: { extract: extract.module },
  });

  NodeAssert.equal(result.code, 0);
  NodeAssert.deepEqual(extract.queued[0].redaction.alwaysRedact, ["Northwind Retail"]);
  NodeAssert.deepEqual(extract.queued[0].redaction.replacements, {
    "Northwind Retail": "a retail client",
  });
});

NodeTest.test("extract-queue says so when there is no always-redact list to apply", async (t) => {
  const box = scenario(t);
  const extract = fakeExtract();
  const result = await runCli(["extract-queue", "--bundle", box.bundlePath, "--root", box.root], {
    deps: { extract: extract.module },
  });

  NodeAssert.equal(result.code, 0);
  NodeAssert.deepEqual(extract.queued[0].redaction, { alwaysRedact: [], replacements: {} });
  NodeAssert.match(result.out, /warning: No redaction list at/u);
});

NodeTest.test("extract-queue rejects a bundle it cannot read", async (t) => {
  const box = scenario(t);
  const missing = await runCli(["extract-queue", "--bundle", "nope.json", "--root", box.root], {
    deps: { extract: fakeExtract().module },
  });
  NodeAssert.equal(missing.code, 2);
  NodeAssert.match(missing.err, /No bundle at nope\.json/u);

  const corrupt = NodePath.join(box.root, ".worklog-tmp", "bundles", "broken.json");
  NodeFS.writeFileSync(corrupt, "{ not json", "utf8");
  const unparseable = await runCli(["extract-queue", "--bundle", corrupt, "--root", box.root], {
    deps: { extract: fakeExtract().module },
  });
  NodeAssert.equal(unparseable.code, 2);
  NodeAssert.match(unparseable.err, /Could not read the bundle/u);

  const missingBundleFlag = await runCli(["extract-queue", "--root", box.root]);
  NodeAssert.equal(missingBundleFlag.code, 2);
  NodeAssert.match(missingBundleFlag.err, /needs --bundle/u);
});

NodeTest.test("extract-commit reads the payload from a file and advances the cursor", async (t) => {
  const box = scenario(t);
  const extract = fakeExtract();
  const now = new Date("2026-08-10T20:00:00.000Z");
  const result = await runCli(
    [
      "extract-commit",
      "--session",
      "t3-abc",
      "--bundle",
      box.bundlePath,
      "--file",
      box.payloadFile,
      "--root",
      box.root,
    ],
    { deps: { extract: extract.module, now: () => now } },
  );

  NodeAssert.equal(result.code, 0);
  NodeAssert.equal(extract.parsed.length, 1);
  NodeAssert.equal(extract.parsed[0], NodeFS.readFileSync(box.payloadFile, "utf8"));
  NodeAssert.equal(extract.committed.length, 1);
  NodeAssert.equal(extract.committed[0].sessionKey, "t3-abc");
  NodeAssert.equal(extract.committed[0].paths.root, box.root);
  // The session comes from the bundle, so the extract file can record what it was about.
  NodeAssert.deepEqual(extract.committed[0].session, BUNDLE.sessions[0]);
  NodeAssert.equal(extract.committed[0].extract.problem, "p");
  NodeAssert.equal(extract.committed[0].now, now);
  NodeAssert.match(
    result.out,
    /Recorded the extract for t3-abc → \/tmp\/extracts\/t3-abc\.json\./u,
  );
  NodeAssert.match(result.out, /cursor: 2026-08-10T18:00:00\.000Z/u);
});

NodeTest.test(
  "extract-commit takes --json as a payload with a value and as an output switch without one",
  async (t) => {
    const box = scenario(t);
    const withPayload = fakeExtract();
    const inline = await runCli(
      [
        "extract-commit",
        "--session",
        "t3-abc",
        "--bundle",
        box.bundlePath,
        "--json",
        '{"problem":"inline"}',
        "--root",
        box.root,
      ],
      { deps: { extract: withPayload.module } },
    );
    NodeAssert.equal(inline.code, 0);
    NodeAssert.equal(withPayload.parsed[0], '{"problem":"inline"}');
    NodeAssert.match(
      inline.out,
      /Recorded the extract/u,
      "a payload value must not switch the output to JSON",
    );

    const bare = await runCli(
      [
        "extract-commit",
        "--json",
        "--session",
        "t3-abc",
        "--bundle",
        box.bundlePath,
        "--file",
        box.payloadFile,
        "--root",
        box.root,
      ],
      { deps: { extract: fakeExtract().module } },
    );
    NodeAssert.equal(bare.code, 0);
    NodeAssert.equal(parseJson(bare.out).session, "t3-abc");
    NodeAssert.equal(parseJson(bare.out).cursor, "2026-08-10T18:00:00.000Z");
  },
);

NodeTest.test(
  "extract-commit rejects a missing session, a missing payload and an unusable one",
  async (t) => {
    const box = scenario(t);

    const unknown = await runCli(
      [
        "extract-commit",
        "--session",
        "t3-nope",
        "--bundle",
        box.bundlePath,
        "--file",
        box.payloadFile,
        "--root",
        box.root,
      ],
      { deps: { extract: fakeExtract().module } },
    );
    NodeAssert.equal(unknown.code, 2);
    NodeAssert.match(unknown.err, /No session "t3-nope"/u);

    const noPayload = await runCli(
      ["extract-commit", "--session", "t3-abc", "--bundle", box.bundlePath, "--root", box.root],
      { deps: { extract: fakeExtract().module } },
    );
    NodeAssert.equal(noPayload.code, 2);
    NodeAssert.match(noPayload.err, /--file F or --json S/u);

    const both = await runCli(
      [
        "extract-commit",
        "--session",
        "t3-abc",
        "--bundle",
        box.bundlePath,
        "--file",
        box.payloadFile,
        "--json",
        "{}",
        "--root",
        box.root,
      ],
      { deps: { extract: fakeExtract().module } },
    );
    NodeAssert.equal(both.code, 2);
    NodeAssert.match(both.err, /not both/u);

    const unreadable = await runCli(
      [
        "extract-commit",
        "--session",
        "t3-abc",
        "--bundle",
        box.bundlePath,
        "--file",
        NodePath.join(box.dir, "gone.json"),
        "--root",
        box.root,
      ],
      { deps: { extract: fakeExtract().module } },
    );
    NodeAssert.equal(unreadable.code, 2);
    NodeAssert.match(unreadable.err, /Could not read the extract/u);

    const thrown = await runCli(
      [
        "extract-commit",
        "--session",
        "t3-abc",
        "--bundle",
        box.bundlePath,
        "--json",
        "not json",
        "--root",
        box.root,
      ],
      { deps: { extract: fakeExtract().module } },
    );
    NodeAssert.equal(thrown.code, 2);
    NodeAssert.match(thrown.err, /payload is not usable/u);

    // `commitExtract` throws on a payload that does not validate. That is the subagent's mistake to
    // fix, so it reads as a usage error (exit 2) rather than an internal one.
    const rejected = fakeExtract({
      commitExtract: () => {
        throw new Error("The extract is missing required fields: status is required.");
      },
    });
    const refused = await runCli(
      [
        "extract-commit",
        "--session",
        "t3-abc",
        "--bundle",
        box.bundlePath,
        "--json",
        "{}",
        "--root",
        box.root,
      ],
      { deps: { extract: rejected.module } },
    );
    NodeAssert.equal(refused.code, 2);
    NodeAssert.match(refused.err, /status is required/u);
    NodeAssert.doesNotMatch(refused.err, /Re-run with --debug/u, "a bad extract is not a crash");
  },
);

// --- JSON output and failure modes ---------------------------------------------------------------

NodeTest.test("--json produces parseable JSON for every command", async (t) => {
  const box = scenario(t);
  const deps = {
    run: repoRun(box.root),
    bundle: fakeBundle().module,
    summary: fakeSummary().module,
    extract: fakeExtract().module,
    init: fakeInit({
      root: box.root,
      registryPath: NodePath.join(box.root, "config", "projects.yaml"),
    }).module,
    discoverProjects: () => ({ candidates: [], warnings: [] }),
    inspectDatabases: () => ({ databases: [], warnings: [] }),
    listSessionFiles: () => [],
  };
  const cases = [
    ["doctor", "--json", "--root", box.root],
    ["init", "--json", "--root", box.root],
    ["projects", "--json", "--root", box.root],
    ["collect", "--json", "--from", DAY, "--root", box.root],
    ["extract-queue", "--json", "--bundle", box.bundlePath, "--root", box.root],
    [
      "extract-commit",
      "--json",
      "--session",
      "t3-abc",
      "--bundle",
      box.bundlePath,
      "--file",
      box.payloadFile,
      "--root",
      box.root,
    ],
    ["lint", "--json", "--file", box.dayFile, "--root", box.root],
    ["publish", "--json", "--date", DAY, "--dry-run", "--root", box.root],
    ["help", "--json"],
  ];

  for (const argv of cases) {
    const result = await runCli(argv, { deps });
    NodeAssert.equal(result.code, 0, `${argv[0]} --json should succeed: ${result.err}`);
    NodeAssert.equal(result.err, "", `${argv[0]} --json should print nothing on stderr`);
    const payload = parseJson(result.out);
    NodeAssert.equal(payload.ok, true, `${argv[0]} --json should report ok`);
    NodeAssert.equal(payload.command, argv[0]);
    NodeAssert.equal(payload.exitCode, 0);
    NodeAssert.ok(
      Array.isArray(payload.warnings),
      `${argv[0]} --json should carry a warnings array`,
    );
  }
});

NodeTest.test("--json reports failures as JSON too, with the exit code", async (t) => {
  const box = scenario(t);

  const usage = await runCli(["collect", "--json", "--from", "nope", "--root", box.root]);
  NodeAssert.equal(usage.code, 2);
  const usagePayload = parseJson(usage.out);
  NodeAssert.equal(usagePayload.ok, false);
  NodeAssert.equal(usagePayload.exitCode, 2);
  NodeAssert.match(usagePayload.error, /YYYY-MM-DD/u);

  NodeFS.writeFileSync(box.dayFile, LEAKY_DAY_FILE, "utf8");
  const lint = await runCli(["lint", "--json", "--file", box.dayFile, "--root", box.root]);
  NodeAssert.equal(lint.code, 1);
  const lintPayload = parseJson(lint.out);
  NodeAssert.equal(lintPayload.ok, false);
  NodeAssert.equal(lintPayload.findings[0].rule, "secret-shape");
  NodeAssert.equal(lintPayload.errors, 1);

  const publish = await runCli(["publish", "--json", "--date", DAY, "--root", box.root], {
    deps: { run: repoRun(box.root) },
  });
  NodeAssert.equal(publish.code, 1);
  const publishPayload = parseJson(publish.out);
  NodeAssert.equal(publishPayload.ok, false);
  NodeAssert.equal(publishPayload.date, DAY);
  NodeAssert.match(publishPayload.error, /Refusing to publish/u);
});

NodeTest.test(
  "an unexpected failure prints one line, and the stack only under --debug",
  async (t) => {
    const box = scenario(t);
    // A collector that answers with no bundle is an integration bug, not a user mistake.
    const empty = { bundle: { collect: async () => null }, summary: fakeSummary().module };
    const quiet = await runCli(["collect", "--from", DAY, "--root", box.root], { deps: empty });
    NodeAssert.equal(quiet.code, 3);
    NodeAssert.match(quiet.err, /lib\/bundle\.mjs returned no bundle\./u);
    NodeAssert.doesNotMatch(quiet.err, /\n\s+at /u, "no stack without --debug");
    NodeAssert.match(quiet.err, /Re-run with --debug/u);

    const loud = await runCli(["collect", "--from", DAY, "--debug", "--root", box.root], {
      deps: empty,
    });
    NodeAssert.equal(loud.code, 3);
    NodeAssert.match(loud.err, /\n\s+at /u, "the stack belongs behind --debug");

    // A summary module with no renderer is the same class of bug: a crash, never a quieter digest.
    const unrenderable = await runCli(["collect", "--from", DAY, "--root", box.root], {
      deps: { bundle: fakeBundle().module, summary: {} },
    });
    NodeAssert.equal(unrenderable.code, 3);
    NodeAssert.match(unrenderable.err, /renderSummary is not a function/u);
    NodeAssert.equal(unrenderable.out, "", "no fallback digest is invented");
  },
);

NodeTest.test("the exit code is both returned and handed to io.exit", async (t) => {
  const box = scenario(t);
  const results = [
    await runCli([]),
    await runCli(["nope"]),
    await runCli(["lint", "--file", box.dayFile, "--root", box.root]),
  ];
  for (const result of results) NodeAssert.deepEqual(result.exits, [result.code]);
  NodeAssert.deepEqual(
    results.map((result) => result.code),
    [0, 2, 0],
  );
});

NodeTest.test("with nothing injected at all, the real module graph loads", async (t) => {
  const box = scenario(t);
  // `gh auth status` would validate a real token over the network; an empty config dir and no
  // token env makes it answer "not logged in" locally. Everything else already points at the
  // sandbox, so this test still reads nothing of the user's.
  withEnv(t, {
    GH_CONFIG_DIR: NodePath.join(box.dir, "gh-config"),
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
  });

  const help = await runCli(["--help"]);
  NodeAssert.equal(help.code, 0);
  NodeAssert.match(help.out, /worklog <command> \[flags\]/u);
  for (const command of commandCatalogue())
    NodeAssert.match(help.out, new RegExp(`\\b${command.name}\\b`));

  const doctor = await runCli(["doctor", "--json", "--root", box.root]);
  NodeAssert.equal(doctor.code, 0);
  NodeAssert.equal(doctor.err, "");
  const payload = parseJson(doctor.out);
  NodeAssert.equal(payload.ok, true);
  NodeAssert.equal(payload.exitCode, 0);
  for (const entry of payload.checks) {
    NodeAssert.ok(
      ["ok", "warn"].includes(entry.status),
      `${entry.id} has an unexpected status ${entry.status}`,
    );
    NodeAssert.equal(typeof entry.detail, "string");
  }
  NodeAssert.deepEqual(
    payload.checks.map((entry) => entry.id).filter((id) => id === "timezone"),
    ["timezone"],
  );
  NodeAssert.equal(typeof payload.timezone, "string");

  // The lazily imported half of the graph resolves too: this runs the real lib/extract.mjs.
  const queue = await runCli([
    "extract-queue",
    "--bundle",
    `bundle-${DAY}_${DAY}.json`,
    "--root",
    box.root,
  ]);
  NodeAssert.equal(queue.code, 0);
  NodeAssert.equal(queue.err, "");
  NodeAssert.match(queue.out, /Nothing new to extract/u);
  NodeAssert.match(queue.out, /2 session\(s\) skipped/u);
});
