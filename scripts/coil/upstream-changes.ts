#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - A one-shot CLI that only reads `git log` output.
/**
 * Lists what an upstream sync brought in, for users rather than builders, by dropping dev-only
 * conventional-commit types and grouping the rest (no model involved). Every sync PR body starts
 * with this output. Usage, from a sync branch with `upstream` fetched:
 *   node scripts/coil/upstream-changes.ts [<fork main before the sync>]   # default origin/main
 */

import * as NodeChildProcess from "node:child_process";

const UPSTREAM_REPO = "pingdotgg/t3code";

// GitHub rejects a PR body over 65,536 characters, and a 1,000-commit range passes that easily.
const MAX_LIST_CHARS = 50_000;

const DEV_ONLY_TYPES = new Set(["build", "chore", "ci", "docs", "refactor", "style", "test"]);

const SECTIONS = ["New", "Fixed and improved", "Reverted", "Other"] as const;

// Anything else, including a subject that is not a conventional commit, may still be user-facing,
// so it lands under "Other" rather than vanishing.
function sectionOf(type: string): (typeof SECTIONS)[number] {
  if (type === "feat") return "New";
  if (type === "fix" || type === "perf") return "Fixed and improved";
  if (type === "revert") return "Reverted";
  return "Other";
}

const CONVENTIONAL = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?!?:\s*(?<description>.+)$/u;
const TRAILING_PR = /\s*\(#(?<number>\d+)\)$/u;

export interface UpstreamCommit {
  readonly sha: string;
  readonly subject: string;
}

interface Change {
  readonly sha: string;
  readonly type: string;
  readonly area: string | null;
  readonly description: string;
  readonly pr: string | null;
}

function parse(commit: UpstreamCommit): Change {
  const prMatch = TRAILING_PR.exec(commit.subject);
  const text = prMatch ? commit.subject.slice(0, prMatch.index) : commit.subject;
  const pr = prMatch?.groups?.number ?? null;
  const match = CONVENTIONAL.exec(text);
  if (!match?.groups) {
    return { sha: commit.sha, type: "", area: null, description: text, pr };
  }
  const area = match.groups.scope
    ? match.groups.scope
        .split(",")
        .map((part) => capitalize(part.trim().replaceAll("-", " ")))
        .join(", ")
    : null;
  return {
    sha: commit.sha,
    type: match.groups.type ?? "",
    area,
    description: match.groups.description ?? text,
    pr,
  };
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// The PR body lives on the fork, so a bare `@name` would notify an upstream contributor and a bare
// `#123` would link the fork's own issue 123. Code spans render both as plain text.
function defuse(text: string) {
  return text.replace(/(^|[\s(])([@#][\w./-]+)/gu, "$1`$2`");
}

function renderLine(change: Change) {
  const area = change.area ? `**${change.area}:** ` : "";
  // Commit links, not PR links: a fork PR linking an upstream PR posts a "mentioned this" event
  // on that PR's timeline, and every sync would do it for every change. Upstream's commit page
  // still links its PR.
  const label = change.pr ? `#${change.pr}` : change.sha.slice(0, 10);
  const link = `[${label}](https://github.com/${UPSTREAM_REPO}/commit/${change.sha})`;
  return `- ${area}${defuse(capitalize(change.description))} (${link})`;
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** `commits` is upstream's range, oldest first. */
export function renderUpstreamChanges(input: {
  readonly commits: ReadonlyArray<UpstreamCommit>;
  readonly base: string;
  readonly head: string;
}): string {
  const changes = input.commits.map(parse).filter((change) => !DEV_ONLY_TYPES.has(change.type));
  const compare = `[Compare the full range](https://github.com/${UPSTREAM_REPO}/compare/${input.base}...${input.head}).`;
  const out = ["## What changed for you", ""];

  if (changes.length === 0) {
    out.push(
      `None of the ${plural(input.commits.length, "upstream commit")} in this update change the app; they are tests, CI, refactors and docs. ${compare}`,
    );
    return `${out.join("\n")}\n`;
  }

  out.push(
    `${plural(changes.length, "user-facing change")} from upstream T3 Code, out of ${plural(input.commits.length, "upstream commit")}. Tests, CI, refactors and docs are left out. ${compare}`,
    "",
  );

  let budget = MAX_LIST_CHARS;
  let omitted = 0;
  for (const section of SECTIONS) {
    const lines: Array<string> = [];
    for (const change of changes) {
      if (sectionOf(change.type) !== section) continue;
      const line = renderLine(change);
      if (omitted > 0 || line.length + 1 > budget) {
        omitted += 1;
        continue;
      }
      budget -= line.length + 1;
      lines.push(line);
    }
    if (lines.length > 0) out.push(`### ${section}`, "", ...lines, "");
  }
  if (omitted > 0) out.push(`…and ${omitted} more. ${compare}`, "");

  return `${out.join("\n").trimEnd()}\n`;
}

function git(cwd: string, ...args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * The upstream commits HEAD has absorbed that `since` had not. Both ends are measured against
 * upstream's branch rather than read off a merge commit's parents, so the answer is the same
 * whether HEAD is the daily job's merge, a resolver branch with fix-ups on top, or a sync landed
 * through GitHub's own "Merge pull request" commit.
 */
export function readUpstreamRange(input: {
  readonly since: string;
  readonly upstream?: string;
  readonly cwd?: string;
}) {
  const upstream = input.upstream ?? "upstream/main";
  const cwd = input.cwd ?? process.cwd();
  const base = git(cwd, "merge-base", input.since, upstream);
  const head = git(cwd, "merge-base", "HEAD", upstream);
  const log = git(
    cwd,
    "log",
    "--reverse",
    "--first-parent",
    "--format=%H%x09%s",
    `${base}..${head}`,
  );
  const commits = log
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const tab = line.indexOf("\t");
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
  return { base, head, commits };
}

if (import.meta.main) {
  process.stdout.write(
    renderUpstreamChanges(readUpstreamRange({ since: process.argv[2] ?? "origin/main" })),
  );
}
