#!/usr/bin/env node
// The /worklog command line: one entry point, one subcommand table, zero dependencies.
//
// This file is deliberately thin. Everything that knows about SQLite, transcripts, git, time
// clustering or redaction lives in ../lib; the job here is to turn argv into a call, turn a
// result into either prose or JSON, and turn a failure into an exit code a script can trust.
//
// Three rules shape the code below:
//
//   1. Argument handling never guesses. An unknown flag, a malformed date, an unusable value —
//      all stop with exit 2 and a message that lists what was actually allowed. A collector that
//      quietly reports the wrong day is worse than one that refuses to start.
//   2. Missing evidence is a warning, never a failure. No database, no `gh`, no network, no
//      worklog repo yet: every command still finishes and says what it could not see. `doctor`
//      takes this furthest — it is a report, so it exits 0 even when nothing is installed.
//   3. Refusing is not crashing. Exit 1 means "I did the check and the answer is no" (lint found
//      something, publish would not commit). Exit 3 is reserved for the bugs, and only `--debug`
//      prints a stack, because a stack trace in a user's terminal is a bug report nobody filed.
//
// `collect`, `extract-queue`, `extract-commit` and `init` delegate to ../lib/bundle.mjs,
// ../lib/summary.mjs, ../lib/extract.mjs and ../lib/init.mjs. Those are imported lazily (see
// loadModule) for one reason: a CLI whose `doctor` cannot run because an unrelated sibling module
// failed to parse is a CLI that cannot diagnose itself.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { listSessionFiles } from "../lib/claudeCode.mjs";
import { eachDay, formatNumber, parseLocalDate, timezoneName } from "../lib/format.mjs";
import { createRunner } from "../lib/git.mjs";
import {
  claudeProjectsDir,
  expandHome,
  t3BaseDirs,
  t3StateDbPath,
  tildify,
  worklogPaths,
} from "../lib/paths.mjs";
import { formatFindings, hasErrors, lintFile, RULES } from "../lib/redact.mjs";
import {
  classify,
  identitiesOf,
  loadRedaction,
  loadRegistry,
  matchProjectByRoot,
  projectKeyFor,
  saveRedaction,
  saveRegistry,
  settingsOf,
  upsertProject,
} from "../lib/registry.mjs";
import { closeDatabases, openT3Databases, readProjects } from "../lib/t3db.mjs";
import { parseYaml } from "../lib/yamlLite.mjs";

/** Exit codes, quoted in `worklog help` because scripts depend on them. */
const EXIT = Object.freeze({ ok: 0, refused: 1, usage: 2, internal: 3 });

// Counted by `doctor`. Ordered cheapest-to-most-interesting so a truncated table still informs.
const DOCTOR_TABLES = Object.freeze([
  ["projection_projects", "projects"],
  ["projection_threads", "threads"],
  ["projection_turns", "turns"],
  ["projection_thread_activities", "activities"],
  ["projection_thread_messages", "messages"],
]);

// Widths for the human tables. Wide enough for every label this file emits.
const STATUS_WIDTH = 6;
const LABEL_WIDTH = 17;

/** Flags every command accepts. Listed in each command's `--help` so the set is never a secret. */
const GLOBAL_FLAGS = {
  json: { type: "boolean", describe: "Machine-readable JSON on stdout." },
  debug: { type: "boolean", describe: "Print the stack trace if something fails unexpectedly." },
  help: { type: "boolean", describe: "Show this help and exit." },
};

const ROOT_FLAG = {
  type: "string",
  value: "DIR",
  describe: "The worklog repo (default: ~/Developer/worklog, or $WORKLOG_ROOT).",
};

const COMMANDS = [
  {
    name: "doctor",
    summary: "Check the environment: databases, transcripts, the worklog repo, git and gh.",
    details:
      "Reports what evidence is reachable. Missing pieces are warnings, so this never exits non-zero.",
    flags: { root: ROOT_FLAG },
    run: runDoctor,
  },
  {
    name: "init",
    summary: "Create the worklog repo and propose a project registry.",
    details:
      "Idempotent: re-running adds newly discovered projects and leaves your classifications alone.",
    flags: {
      root: ROOT_FLAG,
      "no-discover": { type: "boolean", describe: "Skip the T3code project scan." },
    },
    run: runInit,
  },
  {
    name: "projects",
    summary: "List registry entries, and anything discovered but not yet classified.",
    flags: {
      root: ROOT_FLAG,
      "no-discover": { type: "boolean", describe: "Skip the T3code project scan." },
    },
    run: runProjects,
  },
  {
    name: "collect",
    summary: "Build the evidence bundle for a day or a range.",
    details: "Writes .worklog-tmp/bundles/bundle-<from>_<to>.json inside the worklog repo.",
    flags: {
      from: { type: "string", value: "D", required: true, describe: "First day, YYYY-MM-DD." },
      to: { type: "string", value: "D", describe: "Last day, YYYY-MM-DD (default: --from)." },
      print: {
        type: "enum",
        value: "MODE",
        values: ["summary", "json", "both"],
        default: "both",
        describe: "summary | json | both (default: both).",
      },
      gap: {
        type: "number",
        value: "N",
        describe: "Minutes of silence that end an activity block (default: from the registry).",
      },
      "no-git": { type: "boolean", describe: "Skip commits and pull requests." },
      root: ROOT_FLAG,
    },
    run: runCollect,
  },
  {
    name: "extract-queue",
    summary: "Write a transcript slice for every session with new material.",
    flags: {
      bundle: { type: "string", value: "F", required: true, describe: "Bundle path or filename." },
      limit: { type: "number", value: "N", describe: "Stop after N sessions." },
      root: ROOT_FLAG,
    },
    run: runExtractQueue,
  },
  {
    name: "extract-commit",
    summary: "Persist one session extract and advance its read cursor.",
    details:
      "`--json S` carries the payload; a bare `--json` with no value asks for machine-readable output.",
    flags: {
      session: { type: "string", value: "KEY", required: true, describe: "Session key." },
      bundle: {
        type: "string",
        value: "F",
        required: true,
        describe: "The bundle the session came from.",
      },
      file: { type: "string", value: "F", describe: "Read the extract payload from this file." },
      json: { type: "optional-string", value: "S", describe: GLOBAL_FLAGS.json.describe },
      root: ROOT_FLAG,
    },
    run: runExtractCommit,
  },
  {
    name: "lint",
    summary: "The redaction gate. Exit 1 on any blocking finding.",
    flags: {
      file: { type: "string", value: "F", required: true, describe: "Markdown file to check." },
      allow: {
        type: "list",
        value: "RULES",
        describe: "Comma-separated rule ids to suppress; repeatable.",
      },
      root: ROOT_FLAG,
    },
    run: runLint,
  },
  {
    name: "publish",
    summary: "Lint a day or range file, then commit it inside the worklog repo. Never pushes.",
    flags: {
      date: { type: "string", value: "D", describe: "Day to publish, YYYY-MM-DD." },
      range: {
        type: "string",
        value: "F..T",
        describe: "Range file to publish, YYYY-MM-DD..YYYY-MM-DD.",
      },
      message: { type: "string", value: "M", describe: 'Commit message (default: "worklog: D").' },
      "dry-run": { type: "boolean", describe: "Report what would happen; change nothing." },
      allow: { type: "list", value: "RULES", describe: "Rule ids to suppress; repeatable." },
      root: ROOT_FLAG,
    },
    run: runPublish,
  },
  {
    name: "help",
    summary: "Show usage for one command, or for all of them.",
    positionals: "[command]",
    flags: {},
    run: runHelp,
  },
];

const COMMANDS_BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));

/** A caller mistake: a bad flag, a bad value, a file that is not there. Always exit 2. */
class UsageError extends Error {
  constructor(message, command) {
    super(message);
    this.name = "UsageError";
    this.command = command ?? null;
  }
}

/** The command did its job and the answer is no (findings, or nothing to publish). Exit 1. */
class RefusedError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "RefusedError";
    this.extra = extra;
  }
}

/**
 * Run the CLI. Returns the exit code and also hands it to `io.exit`, so a test can drive the
 * whole surface in-process with `{ stdout, stderr, exit }` and never touch the real filesystem.
 */
export async function main(argv = [], io = {}, deps = {}) {
  const ctx = createContext(io, { ...(io?.deps ?? {}), ...deps });
  try {
    const outcome = await dispatch(Array.isArray(argv) ? argv.map(String) : [], ctx);
    emit(ctx, outcome);
    return finish(ctx, outcome.code);
  } catch (error) {
    return finish(ctx, emitFailure(ctx, error, argv));
  }
}

/** Names, summaries and usage for every subcommand — the data `help` and the tests read. */
export function commandCatalogue() {
  return COMMANDS.map((command) => ({
    name: command.name,
    summary: command.summary,
    usage: usageLine(command),
  }));
}

// --- dispatch -----------------------------------------------------------------------------------

async function dispatch(argv, ctx) {
  const [first, ...rest] = argv;

  // A bare invocation is a question, not a mistake: print the map and exit 0. `help` itself goes
  // through the normal path below, so `worklog help --help` describes `help`.
  if (first === undefined || first === "-h" || first === "--help") {
    return { code: EXIT.ok, lines: generalUsage(), json: helpJson() };
  }
  if (first === "--version" || first === "-v") {
    throw new UsageError("There is no --version: this CLI ships with the repo it reports on.");
  }

  const command = COMMANDS_BY_NAME.get(first);
  if (command === undefined) {
    throw new UsageError(
      `Unknown command "${first}". Valid commands: ${COMMANDS.map((c) => c.name).join(", ")}.`,
    );
  }

  const parsed = parseArgs(rest, command);
  withParsed(ctx, command, parsed);

  if (parsed.flags.help === true) {
    return { code: EXIT.ok, lines: commandUsage(command), json: { usage: usageLine(command) } };
  }
  requireFlags(command, parsed);
  return await command.run(ctx);
}

function withParsed(ctx, command, parsed) {
  ctx.parsed = true;
  ctx.command = command;
  ctx.commandName = command.name;
  ctx.flags = parsed.flags;
  ctx.positionals = parsed.positionals;
  ctx.jsonOutput = parsed.flags.json === true;
  ctx.debug = parsed.flags.debug === true;
  return ctx;
}

function requireFlags(command, parsed) {
  // A stray positional is nearly always a flag whose name was forgotten (`worklog collect 2026-08-10`);
  // ignoring it would silently report a different day than the one that was asked for.
  if (command.positionals === undefined && parsed.positionals.length > 0) {
    throw new UsageError(
      `\`worklog ${command.name}\` takes no bare arguments — got "${parsed.positionals[0]}".`,
      command,
    );
  }
  for (const [name, spec] of Object.entries(command.flags ?? {})) {
    if (spec.required !== true) continue;
    if (parsed.flags[flagKey(name)] === undefined) {
      throw new UsageError(`\`worklog ${command.name}\` needs --${name}.`, command);
    }
  }
}

// --- argument parsing ---------------------------------------------------------------------------

// Hand-rolled on purpose (zero dependencies), so the rules are stated once, here:
//   --flag value, --flag=value, and boolean flags that take neither.
//   -h / --help anywhere wins, even after an invalid flag value.
//   A value that starts with a dash must use --flag=value, so a missing value cannot silently
//   swallow the next flag.
function parseArgs(argv, command) {
  const specs = { ...GLOBAL_FLAGS, ...(command.flags ?? {}) };
  const flags = {};
  const positionals = [];
  let index = 0;
  let literal = false;

  while (index < argv.length) {
    const token = argv[index];
    index += 1;

    if (literal || token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      literal = true;
      continue;
    }
    if (token === "-h") {
      flags.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      throw new UsageError(
        `Unknown flag "${token}" for \`worklog ${command.name}\`. ${validFlagsHint(specs)}`,
        command,
      );
    }

    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const inline = equals === -1 ? null : token.slice(equals + 1);
    const spec = Object.hasOwn(specs, name) ? specs[name] : undefined;
    if (spec === undefined) {
      throw new UsageError(
        `Unknown flag "--${name}" for \`worklog ${command.name}\`. ${validFlagsHint(specs)}`,
        command,
      );
    }

    const key = flagKey(name);
    if (spec.type === "boolean") {
      if (inline !== null && inline !== "true" && inline !== "false") {
        throw new UsageError(`--${name} is a switch and takes no value.`, command);
      }
      flags[key] = inline !== "false";
      continue;
    }

    // The one ambiguous flag in the CLI: `extract-commit --json` is a payload when it is given a
    // value and an output switch when it is not. Everything else demands a value.
    if (spec.type === "optional-string") {
      const next = argv[index];
      if (inline !== null) {
        flags[key] = inline;
      } else if (next !== undefined && !looksLikeFlag(next)) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }

    let raw = inline;
    if (raw === null) {
      const next = argv[index];
      if (next === undefined || looksLikeFlag(next)) {
        throw new UsageError(
          `--${name} needs a value (use --${name}=VALUE if the value starts with a dash).`,
          command,
        );
      }
      raw = next;
      index += 1;
    }
    flags[key] = coerceFlag(name, spec, raw, command, flags[key]);
  }

  for (const [name, spec] of Object.entries(specs)) {
    const key = flagKey(name);
    if (flags[key] === undefined && spec.default !== undefined) flags[key] = spec.default;
  }
  return { flags, positionals };
}

function coerceFlag(name, spec, raw, command, previous) {
  if (spec.type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new UsageError(
        `--${name} must be a whole number of ${spec.unit ?? "units"} — got "${raw}".`,
        command,
      );
    }
    return value;
  }
  if (spec.type === "enum") {
    if (!spec.values.includes(raw)) {
      throw new UsageError(
        `--${name} must be one of ${spec.values.join(" | ")} — got "${raw}".`,
        command,
      );
    }
    return raw;
  }
  if (spec.type === "list") {
    // Repeatable and comma-separated, because "--allow a,b" and "--allow a --allow b" are both
    // things people type.
    const parts = raw
      .split(/[\s,]+/u)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    return [...(Array.isArray(previous) ? previous : []), ...parts];
  }
  return raw;
}

function looksLikeFlag(token) {
  return typeof token === "string" && /^--?[A-Za-z]/u.test(token);
}

function flagKey(name) {
  return name.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

function validFlagsHint(specs) {
  return `Valid flags: ${Object.keys(specs)
    .map((name) => `--${name}`)
    .join(", ")}.`;
}

// --- doctor -------------------------------------------------------------------------------------

async function runDoctor(ctx) {
  const paths = worklogPaths(ctx.flags.root);
  const checks = [];
  const warnings = [];

  const baseDirs = t3BaseDirs();
  if (baseDirs.length === 0) {
    checks.push(check("t3-db", "warn", "T3code database", "No ~/.t3 state directory found."));
  } else {
    const inspected = ctx.deps.inspectDatabases(baseDirs);
    warnings.push(...toStringArray(inspected?.warnings));
    for (const db of toArray(inspected?.databases)) {
      const where = tildify(db.dbPath ?? db.baseDir ?? "");
      if (db.exists !== true) {
        checks.push(check("t3-db", "warn", "T3code database", `${where} — not present.`));
        continue;
      }
      if (db.ok !== true) {
        checks.push(
          check(
            "t3-db",
            "warn",
            "T3code database",
            `${where} — ${db.error ?? "could not be opened"}.`,
          ),
        );
        continue;
      }
      const counts = db.counts ?? {};
      const rendered = DOCTOR_TABLES.map(([table, label]) =>
        counts[table] === null || counts[table] === undefined
          ? `${label} ?`
          : `${formatNumber(counts[table])} ${label}`,
      ).join(", ");
      const empty = DOCTOR_TABLES.every(([table]) => !counts[table]);
      checks.push(
        check("t3-db", empty ? "warn" : "ok", "T3code database", `${where} — ${rendered}.`, {
          counts,
        }),
      );
    }
  }

  const ccDir = claudeProjectsDir();
  if (!isDirectory(ccDir)) {
    checks.push(check("claude-code", "warn", "Claude Code logs", `${tildify(ccDir)} — not found.`));
  } else {
    const files = toArray(ctx.deps.listSessionFiles(ccDir));
    checks.push(
      check(
        "claude-code",
        files.length === 0 ? "warn" : "ok",
        "Claude Code logs",
        `${tildify(ccDir)} — ${formatNumber(files.length)} session ${files.length === 1 ? "file" : "files"}.`,
        { sessionFiles: files.length },
      ),
    );
  }

  const rootExists = isDirectory(paths.root);
  if (!rootExists) {
    checks.push(
      check(
        "worklog-root",
        "warn",
        "Worklog repo",
        `${tildify(paths.root)} — run \`worklog init\`.`,
      ),
    );
  } else {
    const inside = ctx.run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: paths.root });
    const isRepo = inside.ok && inside.stdout.trim() === "true";
    const days = countFiles(paths.days, ".md");
    checks.push(
      check(
        "worklog-root",
        isRepo ? "ok" : "warn",
        "Worklog repo",
        `${tildify(paths.root)} — ${isRepo ? "git repo" : "not a git repo (run `worklog init`)"}, ${formatNumber(days)} day ${days === 1 ? "file" : "files"}.`,
        { root: paths.root, isRepo, days },
      ),
    );
  }

  const registryExists = NodeFS.existsSync(paths.projectsYaml);
  if (!registryExists) {
    checks.push(
      check(
        "registry",
        "warn",
        "Project registry",
        `${tildify(paths.projectsYaml)} — not created yet.`,
      ),
    );
  } else {
    const loaded = loadRegistry(paths);
    warnings.push(...toStringArray(loaded.warnings));
    const keys = Object.keys(loaded.registry.projects ?? {});
    const confirmed = keys.filter((key) => classify(loaded.registry, key).confirmed).length;
    checks.push(
      check(
        "registry",
        keys.length === 0 ? "warn" : "ok",
        "Project registry",
        `${formatNumber(keys.length)} ${keys.length === 1 ? "project" : "projects"}, ${formatNumber(confirmed)} confirmed.`,
        { projects: keys.length, confirmed },
      ),
    );
  }

  const identityCwd = rootExists ? paths.root : ctx.cwd;
  const name = gitConfig(ctx, identityCwd, "user.name");
  const email = gitConfig(ctx, identityCwd, "user.email");
  checks.push(
    name === null && email === null
      ? check(
          "git-identity",
          "warn",
          "Git identity",
          "Not configured — `worklog publish` cannot commit.",
        )
      : check(
          "git-identity",
          "ok",
          "Git identity",
          `${name ?? "(no name)"} <${email ?? "no email"}>`,
          {
            name,
            email,
          },
        ),
  );

  const ghVersion = ctx.run("gh", ["--version"], {});
  if (!ghVersion.ok) {
    checks.push(
      check("gh", "warn", "GitHub CLI", "`gh` is not installed — merged PRs will be missing."),
    );
  } else {
    const auth = ctx.run("gh", ["auth", "status"], {});
    checks.push(
      auth.ok
        ? check("gh", "ok", "GitHub CLI", `${firstLine(ghVersion.stdout)} — authenticated.`)
        : check(
            "gh",
            "warn",
            "GitHub CLI",
            `${firstLine(ghVersion.stdout)} — not authenticated (\`gh auth login\`).`,
          ),
    );
  }

  const zone = timezoneName();
  checks.push(check("timezone", "ok", "Timezone", `${zone} — day boundaries are local midnight.`));

  const warned = checks.filter((entry) => entry.status !== "ok").length;
  const lines = ["worklog doctor", ""];
  for (const entry of checks) {
    lines.push(
      `  ${entry.status.padEnd(STATUS_WIDTH)}${entry.label.padEnd(LABEL_WIDTH)}${entry.detail}`,
    );
  }
  lines.push("");
  lines.push(
    warned === 0
      ? "Everything a report needs is reachable."
      : `${warned} ${warned === 1 ? "warning" : "warnings"}. Nothing here blocks a report — each one just means less evidence.`,
  );
  for (const warning of warnings) lines.push(`  warning: ${warning}`);

  // A diagnostic that fails is a diagnostic you cannot run when things are broken.
  return { code: EXIT.ok, lines, json: { checks, timezone: zone }, warnings };
}

function check(id, status, label, detail, extra = {}) {
  return { id, status, label, detail, ...extra };
}

function gitConfig(ctx, cwd, key) {
  const result = ctx.run("git", ["config", "--get", key], { cwd });
  const value = result.ok ? result.stdout.trim() : "";
  return value === "" ? null : value;
}

// --- init ---------------------------------------------------------------------------------------

async function runInit(ctx) {
  const paths = worklogPaths(ctx.flags.root);
  const lines = [`worklog init → ${tildify(paths.root)}`, ""];
  const warnings = [];

  // Reading is safe; overwriting a file we could not understand is not.
  const registryExisted = NodeFS.existsSync(paths.projectsYaml);
  if (registryExisted) {
    const parseError = yamlParseError(paths.projectsYaml);
    if (parseError !== null) {
      throw new RefusedError(
        `${tildify(paths.projectsYaml)} could not be parsed (${parseError}). Fix it or move it aside — init did not touch it.`,
      );
    }
  }

  // Scaffolding, discovery and the registry merge all live in lib/init.mjs. The CLI deliberately
  // owns none of it: a second implementation here is how `inbox-lens` got swallowed by
  // `mission-control` — path containment merged a nested repo into its parent.
  const initModule = await loadModule(ctx, "init");
  const result = await initModule.init({
    root: paths.root,
    deps: {
      run: ctx.run,
      ...(ctx.flags.noDiscover === true ? { ccSessions: [], t3Handles: [] } : {}),
    },
  });
  const created = [...toStringArray(result?.created)];
  warnings.push(
    ...toStringArray(result?.warnings).filter((warning) => !warning.includes("run `worklog init`")),
  );

  const inside = ctx.run("git", ["rev-parse", "--show-toplevel"], { cwd: paths.root });
  const top = inside.ok ? realpathOr(inside.stdout.trim()) : "";
  // Nesting the worklog inside another checkout means `publish` would commit a private report
  // into somebody else's repo. Worth a loud line even though it is legal.
  if (top !== "" && top !== realpathOr(paths.root)) {
    warnings.push(
      `${tildify(paths.root)} sits inside the git repo at ${tildify(top)} — commits would land there.`,
    );
  }

  // The registry is loaded again because `init` may have just written it; seeding identities is the
  // one field discovery cannot infer.
  const loaded = loadRegistry(paths);
  const registry = loaded.registry;
  if (identitiesOf(registry).length === 0) {
    const name = gitConfig(ctx, paths.root, "user.name");
    const email = gitConfig(ctx, paths.root, "user.email");
    registry.identities = [name, email].filter(
      (value) => typeof value === "string" && value !== "",
    );
    if (registry.identities.length === 0) {
      warnings.push("No git identity configured, so `identities:` is empty — add yours by hand.");
    } else {
      saveRegistry(paths, registry);
    }
  }

  const proposed = toArray(result?.discovered).filter((entry) =>
    toStringArray(result?.added).includes(entry?.key),
  );

  lines.push(created.length === 0 ? "  Already set up; nothing to create." : "  Created:");
  for (const entry of created) lines.push(`    ${entry}`);
  if (proposed.length > 0) {
    lines.push("");
    lines.push(
      `  Proposed ${proposed.length} ${proposed.length === 1 ? "project" : "projects"} (all unconfirmed):`,
    );
    for (const entry of proposed) {
      lines.push(`    ${String(entry.key).padEnd(24)}${tildify(toArray(entry.roots)[0] ?? "")}`);
    }
    lines.push("");
    lines.push(
      `  Nothing is named in a report until you set confirmed: true in ${tildify(paths.projectsYaml)}.`,
    );
  }
  for (const warning of warnings) lines.push(`  warning: ${warning}`);

  return {
    code: EXIT.ok,
    lines,
    json: {
      root: paths.root,
      created,
      proposed,
      added: toStringArray(result?.added),
      updated: toStringArray(result?.updated),
      registryPath: paths.projectsYaml,
    },
    warnings,
  };
}

// --- projects -----------------------------------------------------------------------------------

async function runProjects(ctx) {
  const paths = worklogPaths(ctx.flags.root);
  const loaded = loadRegistry(paths);
  const warnings = toStringArray(loaded.warnings);
  const registry = loaded.registry;

  const entries = Object.keys(registry.projects ?? {}).map((key) => {
    const classification = classify(registry, key);
    const entry = registry.projects[key] ?? {};
    return {
      key,
      displayName: typeof entry.displayName === "string" ? entry.displayName : key,
      include: classification.include,
      visibility: classification.visibility,
      confirmed: classification.confirmed,
      effective: classification.effective,
      roots: Array.isArray(entry.roots) ? entry.roots : [],
    };
  });

  const unclassified = [];
  if (ctx.flags.noDiscover !== true) {
    const discovered = ctx.deps.discoverProjects();
    warnings.push(...toStringArray(discovered?.warnings));
    for (const candidate of toArray(discovered?.candidates)) {
      const root = expandHome(candidate?.root ?? "");
      if (root === "" || matchProjectByRoot(registry, root) !== null) continue;
      unclassified.push({
        displayName: String(candidate?.displayName ?? "").trim() || NodePath.basename(root),
        root,
      });
    }
  }

  const lines = [];
  if (entries.length === 0) {
    lines.push(`No projects classified yet in ${tildify(paths.projectsYaml)}.`);
  } else {
    const keyWidth = Math.max(3, ...entries.map((entry) => entry.key.length)) + 2;
    const visibilityWidth = 10;
    lines.push(`${"key".padEnd(keyWidth)}${"effective".padEnd(visibilityWidth)}  name`);
    for (const entry of entries.sort((left, right) => left.key.localeCompare(right.key))) {
      lines.push(
        `${entry.key.padEnd(keyWidth)}${entry.effective.padEnd(visibilityWidth)}  ${entry.displayName}`,
      );
      for (const root of entry.roots) lines.push(`${" ".repeat(keyWidth)}${tildify(root)}`);
    }
  }
  if (unclassified.length > 0) {
    lines.push("");
    lines.push(
      `Discovered but unclassified (${unclassified.length}) — they count in totals but are never described:`,
    );
    for (const entry of unclassified) lines.push(`  ${entry.displayName} — ${tildify(entry.root)}`);
  }
  for (const warning of warnings) lines.push(`warning: ${warning}`);

  return { code: EXIT.ok, lines, json: { projects: entries, unclassified }, warnings };
}

// --- collect ------------------------------------------------------------------------------------

async function runCollect(ctx) {
  const paths = worklogPaths(ctx.flags.root);
  const from = requireDay(ctx.flags.from, "--from");
  const to = ctx.flags.to === undefined ? from : requireDay(ctx.flags.to, "--to");
  let days;
  try {
    days = eachDay(from, to);
  } catch (error) {
    throw new UsageError(describeError(error), ctx.command);
  }

  const loadedRegistry = loadRegistry(paths);
  const loadedRedaction = loadRedaction(paths);
  const warnings = [
    ...toStringArray(loadedRegistry.warnings),
    ...toStringArray(loadedRedaction.warnings),
  ];
  const gapMinutes = ctx.flags.gap ?? settingsOf(loadedRegistry.registry).activeGapMinutes;
  const includeGit = ctx.flags.noGit !== true;

  const bundleModule = await loadModule(ctx, "bundle");
  const summaryModule = await loadModule(ctx, "summary");

  const bundle = await bundleModule.collect({
    from,
    to,
    worklogRoot: paths.root,
    gapMinutes,
    includeGit,
    now: ctx.deps.now(),
    run: ctx.run,
  });

  if (bundle === null || typeof bundle !== "object") {
    throw new Error("lib/bundle.mjs returned no bundle.");
  }
  warnings.push(...toStringArray(bundle.warnings));

  const bundlePath = NodePath.join(paths.bundles, `bundle-${from}_${to}.json`);
  NodeFS.mkdirSync(NodePath.dirname(bundlePath), { recursive: true });
  NodeFS.writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

  const mode = ctx.flags.print ?? "both";
  const summary = mode === "json" ? null : String(summaryModule.renderSummary(bundle));

  const lines = [];
  if (mode === "json") lines.push(JSON.stringify(bundle, null, 2));
  else lines.push(...summary.split("\n"));
  if (mode !== "json") for (const warning of warnings) lines.push(`warning: ${warning}`);
  // Last line by contract: the skill reads the path off the tail of stdout.
  if (mode === "both") lines.push(`bundle: ${bundlePath}`);

  return {
    code: EXIT.ok,
    lines,
    json: {
      bundlePath,
      range: { from, to, days },
      gapMinutes,
      includeGit,
      stats: bundle.stats ?? null,
      ...(mode === "json" ? { bundle } : {}),
      ...(summary === null ? {} : { summary }),
    },
    warnings,
  };
}

// --- extract ------------------------------------------------------------------------------------

async function runExtractQueue(ctx) {
  const paths = worklogPaths(ctx.flags.root);
  const { bundle, bundlePath } = readBundle(ctx, paths, ctx.flags.bundle);

  const extract = await loadModule(ctx, "extract");

  const produced = await extract.queue({
    bundle,
    paths,
    ...(ctx.flags.limit === undefined ? {} : { limit: ctx.flags.limit }),
  });

  const slices = toArray(produced?.queued);
  const skipped = toArray(produced?.skipped);
  const warnings = toStringArray(produced?.warnings);
  const lines = [];
  if (slices.length === 0) {
    lines.push("Nothing new to extract — every session in this bundle is already up to date.");
  } else {
    lines.push(`${slices.length} ${slices.length === 1 ? "slice" : "slices"} written:`);
    for (const slice of slices) {
      lines.push(`  ${slice?.title ?? "(untitled)"}`);
      lines.push(`    ${slice?.sessionKey ?? "?"} — ${slice?.reason ?? ""}`);
      lines.push(`    ${slice?.slicePath ?? ""}`);
    }
  }
  if (skipped.length > 0) {
    lines.push(`${skipped.length} session(s) skipped as immaterial or already current.`);
  }
  for (const warning of warnings) lines.push(`warning: ${warning}`);

  return { code: EXIT.ok, lines, json: { bundlePath, queued: slices, skipped }, warnings };
}

async function runExtractCommit(ctx) {
  const paths = worklogPaths(ctx.flags.root);
  const sessionKey = ctx.flags.session;
  const { bundle, bundlePath } = readBundle(ctx, paths, ctx.flags.bundle);

  const session = toArray(bundle?.sessions).find((entry) => entry?.key === sessionKey) ?? null;
  if (session === null) {
    throw new UsageError(
      `No session "${sessionKey}" in ${bundlePath}. Run \`worklog extract-queue --bundle …\` to see the keys.`,
      ctx.command,
    );
  }

  // `--json` doubles as the output switch, so only a string value counts as a payload here.
  const inlinePayload = typeof ctx.flags.json === "string" ? ctx.flags.json : null;
  const filePath = ctx.flags.file;
  if (inlinePayload === null && filePath === undefined) {
    throw new UsageError(
      "`worklog extract-commit` needs the extract as --file F or --json S.",
      ctx.command,
    );
  }
  if (inlinePayload !== null && filePath !== undefined) {
    throw new UsageError("Give the extract as --file F or as --json S, not both.", ctx.command);
  }

  let raw = inlinePayload;
  if (raw === null) {
    try {
      raw = NodeFS.readFileSync(expandHome(filePath), "utf8");
    } catch (error) {
      throw new UsageError(
        `Could not read the extract at ${filePath}: ${describeError(error)}`,
        ctx.command,
      );
    }
  }

  const extract = await loadModule(ctx, "extract");

  let payload;
  try {
    payload = extract.parseExtractPayload(raw);
  } catch (error) {
    throw new UsageError(`The extract payload is not usable: ${describeError(error)}`, ctx.command);
  }

  let result;
  try {
    result = extract.commitExtract({
      paths,
      sessionKey,
      session,
      extract: payload,
      now: ctx.deps.now(),
    });
  } catch (error) {
    // Validation failures are the caller's to fix (a subagent returned a bad shape), not a crash.
    throw new UsageError(describeError(error), ctx.command);
  }

  const path = result?.file ?? "";
  const cursor = result?.document?.cursor?.lastEventAt ?? null;
  const lines = [`Recorded the extract for ${sessionKey}${path === "" ? "" : ` → ${path}`}.`];
  if (cursor !== null) lines.push(`  cursor: ${cursor}`);

  return { code: EXIT.ok, lines, json: { session: sessionKey, path, cursor }, warnings: [] };
}

// --- lint ---------------------------------------------------------------------------------------

async function runLint(ctx) {
  const paths = worklogPaths(ctx.flags.root);
  const file = expandHome(ctx.flags.file);
  const allow = validateAllow(ctx.flags.allow, ctx.command);
  const context = lintContext(paths);

  const findings = lintFile(file, { ...context.options, allow });
  const blocking = hasErrors(findings);
  const lines = [formatFindings(findings)];
  for (const warning of context.warnings) lines.push(`warning: ${warning}`);
  if (blocking) {
    lines.push("");
    lines.push(
      "Fix these before publishing. `--allow rule,rule` suppresses a rule you have judged safe.",
    );
  }

  return {
    code: blocking ? EXIT.refused : EXIT.ok,
    lines,
    json: { file, findings, errors: findings.filter((f) => f.severity === "error").length, allow },
    warnings: context.warnings,
  };
}

function lintContext(paths) {
  const loadedRegistry = loadRegistry(paths);
  const loadedRedaction = loadRedaction(paths);
  const warnings = [];
  if (!NodeFS.existsSync(paths.projectsYaml)) {
    // Said out loud because the gate is materially weaker without it — no project name is known,
    // so the private-project and private-branch rules cannot fire at all.
    warnings.push(
      `No project registry at ${tildify(paths.projectsYaml)} — the project-name rules were not applied.`,
    );
  } else {
    warnings.push(...toStringArray(loadedRegistry.warnings));
  }
  if (NodeFS.existsSync(paths.redactionYaml))
    warnings.push(...toStringArray(loadedRedaction.warnings));
  return {
    warnings,
    options: { registry: loadedRegistry.registry, redaction: loadedRedaction.redaction },
  };
}

function validateAllow(allow, command) {
  const ids = toStringArray(allow);
  const known = new Set(RULES.map((rule) => rule.id));
  for (const id of ids) {
    if (!known.has(id)) {
      throw new UsageError(
        `Unknown rule "${id}" in --allow. Valid rules: ${[...known].join(", ")}.`,
        command,
      );
    }
  }
  return ids;
}

// --- publish ------------------------------------------------------------------------------------

/**
 * Resolve what `publish` is being asked to commit. A range report is as much a deliverable as a day
 * report, and leaving it unpublishable would push the human into running `git` in the worklog repo
 * by hand — the one thing the skill tells them not to do.
 */
function resolvePublishTarget(ctx) {
  const paths = worklogPaths(ctx.flags.root);
  const hasDate = ctx.flags.date !== undefined;
  const hasRange = ctx.flags.range !== undefined;
  if (hasDate && hasRange) {
    throw new UsageError("Give either --date or --range, not both.", ctx.command);
  }
  if (!hasDate && !hasRange) {
    throw new UsageError("`worklog publish` needs --date D or --range F..T.", ctx.command);
  }

  if (hasDate) {
    const date = requireDay(ctx.flags.date, "--date");
    return {
      date,
      label: date,
      relative: `days/${date}.md`,
      file: NodePath.join(paths.days, `${date}.md`),
    };
  }

  const raw = String(ctx.flags.range).trim();
  const parts = raw.split("..");
  if (parts.length !== 2) {
    throw new UsageError(`--range: expected YYYY-MM-DD..YYYY-MM-DD, got "${raw}".`, ctx.command);
  }
  const from = requireDay(parts[0], "--range");
  const to = requireDay(parts[1], "--range");
  const label = `${from}..${to}`;
  return {
    date: from,
    label,
    relative: `ranges/${label}.md`,
    file: NodePath.join(paths.ranges, `${label}.md`),
  };
}

async function runPublish(ctx) {
  const paths = worklogPaths(ctx.flags.root);
  const target = resolvePublishTarget(ctx);
  const { date, relative, file } = target;
  const message = ctx.flags.message ?? `worklog: ${target.label}`;
  const allow = validateAllow(ctx.flags.allow, ctx.command);

  if (!isFile(file)) {
    throw new RefusedError(`Nothing to publish: ${relative} does not exist yet.`, { file, date });
  }

  const context = lintContext(paths);
  const findings = lintFile(file, { ...context.options, allow });
  if (hasErrors(findings)) {
    throw new RefusedError(
      `Refusing to publish ${relative} — the redaction gate found blocking issues.`,
      {
        file,
        date,
        findings,
        report: formatFindings(findings),
      },
    );
  }

  const inside = ctx.run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: paths.root });
  if (!(inside.ok && inside.stdout.trim() === "true")) {
    throw new RefusedError(
      `${tildify(paths.root)} is not a git repository — run \`worklog init\` first.`,
      {
        file,
        date,
      },
    );
  }

  // The day file is the deliverable; config and extracts are its provenance, so they ride along
  // when they exist. Nothing outside the worklog repo is ever touched.
  const staged = [
    relative,
    ...["config", "extracts"].filter((dir) => isDirectory(NodePath.join(paths.root, dir))),
  ];
  const warnings = [...context.warnings];

  if (ctx.flags.dryRun === true) {
    const status = ctx.run("git", ["status", "--porcelain", "--", ...staged], { cwd: paths.root });
    if (!status.ok) {
      throw new RefusedError(
        `\`git status\` failed in the worklog repo: ${firstLine(status.stderr)}`,
        { file, date },
      );
    }
    if (status.stdout.trim() === "") {
      throw new RefusedError(`Nothing to commit: ${relative} is unchanged.`, { file, date });
    }
    return {
      code: EXIT.ok,
      lines: [
        `Dry run — ${relative} passes the redaction gate.`,
        `  would stage:  ${staged.join(", ")}`,
        `  would commit: ${message}`,
        ...warnings.map((warning) => `warning: ${warning}`),
      ],
      json: { date, file, dryRun: true, committed: false, staged, message, findings },
      warnings,
    };
  }

  const add = ctx.run("git", ["add", "--", ...staged], { cwd: paths.root });
  if (!add.ok) {
    throw new RefusedError(`\`git add\` failed in the worklog repo: ${firstLine(add.stderr)}`, {
      file,
      date,
    });
  }

  // `git diff --cached --quiet` exits 0 when the index matches HEAD, i.e. nothing changed.
  const diff = ctx.run("git", ["diff", "--cached", "--quiet", "--", ...staged], {
    cwd: paths.root,
  });
  if (diff.ok)
    throw new RefusedError(`Nothing to commit: ${relative} is unchanged.`, { file, date });
  if (diff.code !== 1) {
    throw new RefusedError(
      `Could not inspect the worklog index: ${firstLine(diff.stderr) || "git failed"}`,
      {
        file,
        date,
      },
    );
  }

  const commit = ctx.run("git", ["commit", "-m", message], { cwd: paths.root });
  if (!commit.ok) {
    throw new RefusedError(
      `\`git commit\` failed: ${firstLine(commit.stderr) || firstLine(commit.stdout)}`,
      {
        file,
        date,
      },
    );
  }

  const head = ctx.run("git", ["rev-parse", "--short", "HEAD"], { cwd: paths.root });
  const sha = head.ok ? head.stdout.trim() : null;
  return {
    code: EXIT.ok,
    lines: [
      `Committed ${relative}${sha === null ? "" : ` as ${sha}`} in ${tildify(paths.root)}.`,
      "  Nothing was pushed; this repo has no remote by design.",
      ...warnings.map((warning) => `warning: ${warning}`),
    ],
    json: { date, file, dryRun: false, committed: true, staged, message, sha },
    warnings,
  };
}

// --- help ---------------------------------------------------------------------------------------

async function runHelp(ctx) {
  const requested = ctx.positionals?.[0];
  if (requested === undefined) return { code: EXIT.ok, lines: generalUsage(), json: helpJson() };

  const command = COMMANDS_BY_NAME.get(requested);
  if (command === undefined) {
    throw new UsageError(
      `Unknown command "${requested}". Valid commands: ${COMMANDS.map((c) => c.name).join(", ")}.`,
    );
  }
  return { code: EXIT.ok, lines: commandUsage(command), json: { usage: usageLine(command) } };
}

function helpJson() {
  return { commands: commandCatalogue(), exitCodes: EXIT };
}

function usageLine(command) {
  const parts = [`worklog ${command.name}`];
  if (command.positionals) parts.push(command.positionals);
  for (const [name, spec] of Object.entries(command.flags ?? {})) {
    const token = spec.type === "boolean" ? `--${name}` : `--${name} ${spec.value ?? "VALUE"}`;
    parts.push(spec.required === true ? token : `[${token}]`);
  }
  parts.push("[--json]");
  return parts.join(" ");
}

function commandUsage(command) {
  const lines = [`worklog ${command.name} — ${command.summary}`, ""];
  if (command.details) lines.push(command.details, "");
  lines.push("Usage:", `  ${usageLine(command)}`, "", "Flags:");
  for (const [name, spec] of Object.entries({ ...(command.flags ?? {}), ...GLOBAL_FLAGS })) {
    const token = spec.type === "boolean" ? `--${name}` : `--${name} ${spec.value ?? "VALUE"}`;
    lines.push(`  ${token.padEnd(20)}${spec.describe}`);
  }
  return lines;
}

function generalUsage() {
  const lines = [
    "worklog — reconstruct what you worked on, then draft a shareable log.",
    "",
    "Usage:",
    "  worklog <command> [flags]",
    "",
    "Commands:",
  ];
  for (const command of COMMANDS) lines.push(`  ${command.name.padEnd(16)}${command.summary}`);
  lines.push(
    "",
    "Every command takes --json for machine-readable output and --help for its own usage.",
    "",
    "Exit codes:",
    `  ${EXIT.ok}  done`,
    `  ${EXIT.refused}  refused — lint found something, or there was nothing to publish`,
    `  ${EXIT.usage}  usage error`,
    `  ${EXIT.internal}  unexpected internal error (re-run with --debug for the stack)`,
  );
  return lines;
}

// --- context, output and failure ------------------------------------------------------------------

function createContext(io, deps) {
  const stdout =
    typeof io?.stdout === "function" ? io.stdout : (text) => process.stdout.write(text);
  const stderr =
    typeof io?.stderr === "function" ? io.stderr : (text) => process.stderr.write(text);
  const exit =
    typeof io?.exit === "function"
      ? io.exit
      : (code) => {
          process.exitCode = code;
        };
  const resolved = { ...defaultDeps(), ...deps };
  return {
    out: (line = "") => stdout(`${line}\n`),
    err: (line = "") => stderr(`${line}\n`),
    exit,
    cwd: typeof io?.cwd === "string" && io.cwd !== "" ? io.cwd : process.cwd(),
    deps: resolved,
    run: resolved.run,
    modules: new Map(),
    parsed: false,
    jsonOutput: false,
    debug: false,
    commandName: null,
    command: null,
    flags: {},
    positionals: [],
  };
}

function defaultDeps() {
  const run = createRunner();
  return {
    run,
    now: () => new Date(),
    listSessionFiles: (dir) => listSessionFiles(dir),
    inspectDatabases: inspectDatabasesDefault,
    discoverProjects: discoverProjectsDefault,
  };
}

function emit(ctx, outcome) {
  if (ctx.jsonOutput) {
    ctx.out(JSON.stringify(jsonEnvelope(ctx, outcome), null, 2));
    return;
  }
  for (const line of toArray(outcome.lines)) ctx.out(line);
  for (const line of toArray(outcome.errorLines)) ctx.err(line);
}

function jsonEnvelope(ctx, outcome) {
  return {
    ok: outcome.code === EXIT.ok,
    command: ctx.commandName,
    ...(outcome.json ?? {}),
    warnings: toStringArray(outcome.warnings),
    exitCode: outcome.code,
  };
}

function emitFailure(ctx, error, argv) {
  const usage = error instanceof UsageError;
  const refused = error instanceof RefusedError;
  const code = usage ? EXIT.usage : refused ? EXIT.refused : EXIT.internal;
  const message = describeError(error);
  // The flags may never have been parsed (that is often what failed), so fall back to scanning
  // argv — but only then, because `extract-commit --json '{…}'` is a payload, not an output mode.
  const wantsJson = ctx.jsonOutput || (!ctx.parsed && rawFlagPresent(argv, "--json"));
  const wantsDebug = ctx.debug || (!ctx.parsed && rawFlagPresent(argv, "--debug"));

  if (wantsJson) {
    ctx.out(
      JSON.stringify(
        {
          ok: false,
          command: ctx.commandName,
          error: message,
          ...(refused ? redactableExtra(error.extra) : {}),
          exitCode: code,
        },
        null,
        2,
      ),
    );
    return code;
  }

  if (refused && typeof error.extra?.report === "string") ctx.out(error.extra.report);
  ctx.err(usage ? `worklog: ${message}` : message);
  if (usage) {
    const name = error.command?.name ?? ctx.commandName;
    ctx.err(name ? `Try \`worklog ${name} --help\`.` : "Try `worklog help`.");
  }
  if (code === EXIT.internal) {
    // One line by default: a stack trace is for whoever is fixing this, not whoever hit it.
    ctx.err(
      wantsDebug && error instanceof Error
        ? String(error.stack)
        : "Re-run with --debug for the stack trace.",
    );
  }
  return code;
}

function redactableExtra(extra) {
  if (extra === null || typeof extra !== "object") return {};
  const { report, ...rest } = extra;
  return rest;
}

function rawFlagPresent(argv, flag) {
  return (
    Array.isArray(argv) &&
    argv.some((token) => token === flag || String(token).startsWith(`${flag}=`))
  );
}

function finish(ctx, code) {
  try {
    ctx.exit(code);
  } catch {
    // A caller whose exit throws (process.exit stubs do) still gets the code as the return value.
  }
  return code;
}

// --- shared helpers -------------------------------------------------------------------------------

// bundle/summary/extract are loaded on demand so `worklog lint` and `worklog doctor` never pay to
// open node:sqlite. Tests inject them through ctx.deps under the same names.
async function loadModule(ctx, name) {
  if (ctx.deps[name] !== undefined && ctx.deps[name] !== null) return ctx.deps[name];
  if (ctx.modules.has(name)) return ctx.modules.get(name);
  const module = await import(new URL(`../lib/${name}.mjs`, import.meta.url).href);
  ctx.modules.set(name, module);
  return module;
}

function readBundle(ctx, paths, flagValue) {
  const candidates = [expandHome(flagValue), NodePath.join(paths.bundles, String(flagValue))];
  const found = candidates.find((candidate) => candidate !== "" && isFile(candidate));
  if (found === undefined) {
    throw new UsageError(
      `No bundle at ${flagValue} — run \`worklog collect --from … --to …\` first.`,
      ctx.command,
    );
  }
  let bundle;
  try {
    bundle = JSON.parse(NodeFS.readFileSync(found, "utf8"));
  } catch (error) {
    throw new UsageError(
      `Could not read the bundle at ${found}: ${describeError(error)}`,
      ctx.command,
    );
  }
  if (bundle === null || typeof bundle !== "object") {
    throw new UsageError(`The bundle at ${found} is not a JSON object.`, ctx.command);
  }
  return { bundle, bundlePath: found };
}

function requireDay(value, flag) {
  try {
    parseLocalDate(value);
  } catch (error) {
    throw new UsageError(`${flag}: ${describeError(error)}`);
  }
  return value.trim();
}

function inspectDatabasesDefault(baseDirs) {
  const warnings = [];
  const opened = openT3Databases(baseDirs);
  warnings.push(...toStringArray(opened.warnings));
  const byPath = new Map(opened.handles.map((handle) => [handle.dbPath, handle]));

  const databases = [];
  try {
    for (const baseDir of toArray(baseDirs)) {
      const dbPath = t3StateDbPath(baseDir);
      const handle = byPath.get(dbPath);
      if (handle === undefined) {
        databases.push({ baseDir, dbPath, exists: NodeFS.existsSync(dbPath), ok: false });
        continue;
      }
      const counts = {};
      for (const [table] of DOCTOR_TABLES) counts[table] = countRows(handle.db, table);
      databases.push({ baseDir, dbPath, exists: true, ok: true, counts });
    }
  } finally {
    closeDatabases(opened.handles);
  }
  return { databases, warnings };
}

function countRows(db, table) {
  try {
    // `table` only ever comes from DOCTOR_TABLES, never from user input.
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    const value = Number(row?.n);
    return Number.isFinite(value) ? value : null;
  } catch {
    // A drifted schema is a warning-shaped fact, not a reason to abandon the diagnostic.
    return null;
  }
}

function discoverProjectsDefault() {
  const warnings = [];
  const baseDirs = t3BaseDirs();
  if (baseDirs.length === 0) {
    warnings.push("No T3code state directory found, so no projects were discovered.");
    return { candidates: [], warnings };
  }

  const opened = openT3Databases(baseDirs);
  warnings.push(...toStringArray(opened.warnings));
  const candidates = [];
  const seen = new Set();
  try {
    const rows = readProjects(opened.handles);
    warnings.push(...toStringArray(rows?.warnings));
    for (const row of toArray(rows)) {
      if (row?.deletedAt) continue;
      const root = expandHome(row?.workspaceRoot ?? "");
      if (root === "" || seen.has(root)) continue;
      seen.add(root);
      candidates.push({
        displayName: String(row?.title ?? "").trim() || NodePath.basename(root),
        root,
        source: "t3code",
      });
    }
  } catch (error) {
    warnings.push(`Project discovery failed: ${describeError(error)}`);
  } finally {
    closeDatabases(opened.handles);
  }
  return { candidates, warnings };
}

function yamlParseError(file) {
  try {
    parseYaml(NodeFS.readFileSync(file, "utf8"));
    return null;
  } catch (error) {
    return describeError(error);
  }
}

function countFiles(dir, suffix) {
  try {
    return NodeFS.readdirSync(dir).filter((name) => name.endsWith(suffix)).length;
  } catch {
    return 0;
  }
}

function isDirectory(p) {
  try {
    return NodeFS.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return NodeFS.statSync(p, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

function realpathOr(p) {
  try {
    return NodeFS.realpathSync(p);
  } catch {
    return p;
  }
}

function firstLine(text) {
  return String(text ?? "")
    .split("\n")[0]
    .trim();
}

function describeError(error) {
  if (error instanceof Error && typeof error.message === "string" && error.message !== "") {
    return error.message;
  }
  return String(error ?? "unknown error");
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

function toStringArray(value) {
  return toArray(value)
    .map((entry) =>
      typeof entry === "string"
        ? entry
        : entry === null || entry === undefined
          ? ""
          : String(entry),
    )
    .filter((entry) => entry !== "");
}

if (import.meta.main) {
  // Node's default handler prints a stack for both of these; the CLI contract is one line.
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`worklog: ${describeError(reason)}\n`);
    process.exit(EXIT.internal);
  });
  process.on("uncaughtException", (error) => {
    process.stderr.write(`worklog: ${describeError(error)}\n`);
    process.exit(EXIT.internal);
  });
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
