// The compact markdown digest of an evidence bundle — the ONLY thing the model reads by default.
//
// The bundle is megabytes; this is a few hundred lines. Everything here is a budgeting decision:
// what does a writer need in order to know which work mattered, and nothing more. Each section is
// capped and reports what it dropped, because a silently truncated summary would have the model
// confidently writing about a day it only half saw.
//
// Nothing is redacted here. The summary is written to a gitignored temp dir and read by the model,
// which needs the private project's real name to decide it must NOT be named. Redaction happens at
// the other end of the pipeline, in `worklog lint`. Two rules still hold: paths are rendered
// repo-relative (or `~`-shortened), and tool OUTPUT never appears — only titles, counts and the
// short `detail` labels the collector already vetted.

import { formatDuration, formatHours, formatNumber, pluralize } from "./format.mjs";
import { tildify } from "./paths.mjs";

// Section caps. A busy day should land near 300 lines and never run away.
const MAX_WARNINGS = 12;
const MAX_UNCLASSIFIED = 10;
const MAX_BLOCKS = 16;
const MAX_PROJECTS = 12;
const MAX_SESSIONS_PER_PROJECT = 12;
const MAX_LINKED_PER_PROJECT = 4;
const MAX_COMMITS_PER_PROJECT = 10;
const MAX_PRS_PER_PROJECT = 6;
const MAX_FILES_PER_PROJECT = 6;
const MAX_NEEDS_EXTRACTION = 20;
const MAX_EXTRACTS = 14;
const MAX_SIGNALS = 3;

// The projects section is the one that scales with the day, so it gets a line budget as well as a
// count cap: ten quiet projects must not crowd out the extracts, which are the most useful part.
const PROJECT_SECTION_MAX_LINES = 220;

const EXTRACT_FIELD_MAX_CHARS = 400;

/** Render the evidence bundle as the compact markdown digest the model reads. */
export function renderSummary(bundle) {
  const lines = [];
  const range = bundle?.range ?? {};
  const stats = bundle?.stats ?? {};

  lines.push(`# Worklog evidence — ${rangeLabel(range)} (${range.timezone ?? "local"})`);
  lines.push("");
  lines.push(
    `Collected ${bundle?.generatedAt ?? "unknown"} · schema ${bundle?.schemaVersion ?? "?"} · ` +
      `gap ${bundle?.config?.activeGapMinutes ?? "?"}m` +
      (bundle?.config?.includeGit === false ? " · git skipped (--no-git)" : ""),
  );

  pushWarnings(lines, bundle);
  pushUnclassified(lines, bundle);
  pushUnconfirmed(lines, bundle);

  lines.push("");
  lines.push("## Stats");
  lines.push("");
  lines.push(renderStatLine(bundle));

  pushActiveBlocks(lines, bundle, stats);
  const rendered = pushProjects(lines, bundle);
  pushUnattributed(lines, bundle, rendered);
  pushNeedsExtraction(lines, bundle);
  pushExtracts(lines, bundle);

  lines.push("");
  return lines.join("\n");
}

/** The one-line stat garnish: `3 projects · 12 sessions · … · 6h 12m active · 31.4h agent`. */
export function renderStatLine(bundle) {
  const stats = bundle?.stats ?? {};
  const parts = [];
  const add = (value, render) => {
    if (count(value) > 0) parts.push(render(count(value)));
  };

  add(stats.projectsTouched, (n) => `${n} ${pluralize(n, "project")}`);
  parts.push(`${count(stats.sessions)} ${pluralize(count(stats.sessions), "session")}`);
  add(stats.turns, (n) => `${formatNumber(n)} ${pluralize(n, "turn")}`);
  add(stats.commits, (n) => `${n} ${pluralize(n, "commit")}`);
  add(stats.prsMerged, (n) => `${n} ${pluralize(n, "PR")} merged`);
  add(stats.filesTouched, (n) => `${formatNumber(n)} ${pluralize(n, "file")}`);
  if (count(stats.linesAdded) > 0 || count(stats.linesRemoved) > 0) {
    parts.push(
      `+${formatNumber(count(stats.linesAdded))}/-${formatNumber(count(stats.linesRemoved))}`,
    );
  }
  add(stats.tokens, (n) => `${formatNumber(n)} tokens`);
  parts.push(`${formatDuration(count(stats.activeMs))} active`);
  parts.push(`${formatHours(count(stats.agentRuntimeMs))} agent`);
  return parts.join(" · ");
}

// --- sections -----------------------------------------------------------------------------------

function pushWarnings(lines, bundle) {
  const warnings = asArray(bundle?.warnings);
  if (warnings.length === 0) return;
  lines.push("");
  lines.push(`## Warnings (${warnings.length})`);
  lines.push("");
  for (const warning of warnings.slice(0, MAX_WARNINGS)) lines.push(`- ${oneLine(warning)}`);
  pushOverflow(lines, warnings.length - MAX_WARNINGS, "warning");
}

function pushUnclassified(lines, bundle) {
  const entries = asArray(bundle?.unclassified);
  if (entries.length === 0) return;
  lines.push("");
  lines.push(`## Unclassified projects (${entries.length})`);
  lines.push("");
  lines.push(
    "Touched, but missing from `config/projects.yaml`. They count toward the totals and must NOT " +
      "be named or described until `worklog classify` records a decision.",
  );
  lines.push("");
  for (const entry of entries.slice(0, MAX_UNCLASSIFIED)) {
    const roots = asArray(entry?.roots).map(tildify).join(", ");
    const evidence = [
      plural(entry?.evidence?.sessions, "session"),
      plural(entry?.evidence?.commits, "commit"),
    ]
      .filter((part) => part !== null)
      .join(", ");
    lines.push(
      `- \`${entry?.key ?? "?"}\` ${entry?.displayName ?? ""}${roots === "" ? "" : ` (${roots})`}` +
        `${evidence === "" ? "" : ` — ${evidence}`}`,
    );
  }
  pushOverflow(lines, entries.length - MAX_UNCLASSIFIED, "project");
}

/**
 * Projects that ARE in the registry but that nobody has confirmed. They read as private everywhere
 * downstream, so their work silently vanishes from the narrative while still moving every number.
 * That silence is exactly what the report header has to break — an unflagged omission is the one
 * failure mode a reader cannot detect.
 */
function pushUnconfirmed(lines, bundle) {
  const entries = asArray(bundle?.projects).filter(
    (project) =>
      project?.classification?.known !== false &&
      project?.classification?.effective === "unconfirmed" &&
      count(project?.stats?.sessions) + count(project?.stats?.commits) > 0,
  );
  if (entries.length === 0) return;
  lines.push("");
  lines.push(`## Unconfirmed projects (${entries.length})`);
  lines.push("");
  lines.push(
    "In `config/projects.yaml` but not confirmed, so they are treated as private: counted in the " +
      "totals, never named or described. **Say so in the report header** — see the heads-up line in " +
      "`reference/report-format.md`.",
  );
  lines.push("");
  for (const project of entries.slice(0, MAX_UNCLASSIFIED)) {
    const evidence = [
      plural(project?.stats?.sessions, "session"),
      plural(project?.stats?.commits, "commit"),
    ]
      .filter((part) => part !== null)
      .join(", ");
    lines.push(`- \`${project?.key ?? "?"}\`${evidence === "" ? "" : ` — ${evidence}`}`);
  }
  pushOverflow(lines, entries.length - MAX_UNCLASSIFIED, "project");
}

function pushActiveBlocks(lines, bundle, stats) {
  const blocks = asArray(stats?.activeBlocks);
  if (blocks.length === 0) return;
  const multiDay = asArray(bundle?.range?.days).length > 1;
  lines.push("");
  lines.push(
    `## Active blocks — ${formatDuration(count(stats.activeMs))} across ` +
      `${blocks.length} ${pluralize(blocks.length, "block")}`,
  );
  lines.push("");
  for (const block of blocks.slice(0, MAX_BLOCKS)) {
    const from = clock(block?.start, multiDay);
    const to = clock(block?.end, multiDay);
    // A block of one event has no span to draw; rendering it as `11:30–11:30` reads like a bug.
    lines.push(
      from === to
        ? `- ${from} · ${formatDuration(count(block?.ms))} (single event)`
        : `- ${from}–${to} · ${formatDuration(count(block?.ms))}`,
    );
  }
  pushOverflow(lines, blocks.length - MAX_BLOCKS, "block");
}

// Returns the session keys it printed, so nothing can quietly disappear between the sections.
function pushProjects(lines, bundle) {
  const printed = new Set();
  const projects = asArray(bundle?.projects);
  if (projects.length === 0) return printed;
  const sessions = asArray(bundle?.sessions);
  const repos = asArray(bundle?.git?.repos);

  lines.push("");
  lines.push("## Projects");

  const start = lines.length;
  let rendered = 0;
  for (const project of projects.slice(0, MAX_PROJECTS)) {
    if (lines.length - start > PROJECT_SECTION_MAX_LINES) break;
    renderProject(
      lines,
      project,
      sessions,
      repos,
      asArray(bundle?.range?.days).length > 1,
      printed,
    );
    rendered += 1;
  }
  pushOverflow(lines, projects.length - rendered, "project");
  return printed;
}

// A t3code-driven session belongs to no project (its cwd is a throwaway worktree), so without this
// the model would see a session count it could not reconcile with anything on the page.
function pushUnattributed(lines, bundle, printed) {
  const leftovers = asArray(bundle?.sessions).filter((session) => !printed.has(session?.key));
  if (leftovers.length === 0) return;

  // The claim on this heading has to stay true, so it is asserted rather than assumed: anything
  // still counted lands in its project's own list above, never here.
  const stillCounted = leftovers.filter(
    (session) => session?.excluded == null && isText(session?.projectKey),
  );
  const rest = leftovers.filter((session) => !stillCounted.includes(session));

  if (stillCounted.length > 0) {
    lines.push("");
    lines.push(`## Counted sessions not shown above (${stillCounted.length})`);
    lines.push("");
    lines.push("These DO count toward the totals — their project's list was full.");
    lines.push("");
    for (const session of stillCounted.slice(0, MAX_SESSIONS_PER_PROJECT)) {
      lines.push(`- ${sessionLine(session)}`);
    }
    pushOverflow(lines, stillCounted.length - MAX_SESSIONS_PER_PROJECT, "session");
  }

  if (rest.length === 0) return;
  lines.push("");
  lines.push(`## Sessions outside the project list (${rest.length})`);
  lines.push("");
  lines.push(
    "Linked to a T3code thread, machine-generated, switched off, or not attributed — none of them count.",
  );
  lines.push("");
  for (const session of rest.slice(0, MAX_SESSIONS_PER_PROJECT)) {
    lines.push(`- ${sessionLine(session)}`);
  }
  pushOverflow(lines, rest.length - MAX_SESSIONS_PER_PROJECT, "session");
}

function renderProject(lines, project, sessions, repos, multiDay, printed) {
  const stats = project?.stats ?? {};
  lines.push("");
  lines.push(
    `### ${project?.key ?? "?"} · ${project?.displayName ?? ""} · ${classificationLabel(project?.classification)}`,
  );
  lines.push("");
  lines.push(renderStatLine({ stats: { ...stats, projectsTouched: 0 } }));

  // Counted and excluded sessions are listed and counted SEPARATELY. Mixing them put "… and 42 more
  // sessions" under a heading that said "10 sessions", and pushed real work into the "none of these
  // count" section further down — both of which a writer would have taken at face value.
  const mine = sessions
    .filter((session) => session?.projectKey === project?.key)
    .sort((left, right) => count(right?.activeMs) - count(left?.activeMs));
  const counted = mine.filter((session) => session?.excluded == null);
  const linked = mine.filter((session) => session?.excluded != null);

  if (counted.length > 0) {
    lines.push("");
    lines.push("Sessions:");
    for (const session of counted.slice(0, MAX_SESSIONS_PER_PROJECT)) {
      lines.push(`- ${sessionLine(session)}`);
      printed.add(session?.key);
    }
    pushOverflow(lines, counted.length - MAX_SESSIONS_PER_PROJECT, "counted session");
  }

  if (linked.length > 0) {
    lines.push("");
    lines.push(
      `Not counted — ${linked.length} duplicate or machine-generated ${pluralize(linked.length, "session")}:`,
    );
    for (const session of linked.slice(0, MAX_LINKED_PER_PROJECT)) {
      lines.push(`- ${sessionLine(session)}`);
      printed.add(session?.key);
    }
    pushOverflow(lines, linked.length - MAX_LINKED_PER_PROJECT, "linked session");
  }

  const owned = repos.filter((repo) => repo?.projectKey === project?.key);
  const commits = owned.flatMap((repo) => asArray(repo?.commits));
  if (commits.length > 0) {
    lines.push("");
    lines.push("Commits:");
    for (const commit of commits.slice(0, MAX_COMMITS_PER_PROJECT)) {
      const when = multiDay ? ` (${clock(commit?.at, true)})` : "";
      lines.push(
        `- \`${commit?.shortSha ?? shortSha(commit?.sha)}\` ${oneLine(commit?.subject)}${when}`,
      );
    }
    pushOverflow(lines, commits.length - MAX_COMMITS_PER_PROJECT, "commit");
  }

  const prs = owned.flatMap((repo) => asArray(repo?.mergedPrs));
  if (prs.length > 0) {
    lines.push("");
    lines.push("Merged PRs:");
    for (const pr of prs.slice(0, MAX_PRS_PER_PROJECT)) {
      lines.push(
        `- #${pr?.number ?? "?"} ${oneLine(pr?.title)} ` +
          `(+${formatNumber(count(pr?.additions))}/-${formatNumber(count(pr?.deletions))})`,
      );
    }
    pushOverflow(lines, prs.length - MAX_PRS_PER_PROJECT, "PR");
  }

  const files = topFiles(mine);
  if (files.length > 0) {
    lines.push("");
    lines.push("Top changed files:");
    for (const file of files.slice(0, MAX_FILES_PER_PROJECT)) {
      lines.push(
        `- ${file.path} (+${formatNumber(file.additions)}/-${formatNumber(file.deletions)})`,
      );
    }
    pushOverflow(lines, files.length - MAX_FILES_PER_PROJECT, "file");
  }
}

function pushNeedsExtraction(lines, bundle) {
  const queued = asArray(bundle?.sessions).filter((session) => session?.needsExtraction === true);
  lines.push("");
  lines.push(`## Sessions needing extraction (${queued.length})`);
  lines.push("");
  if (queued.length === 0) {
    lines.push("None — every material session already has a current extract.");
    return;
  }
  for (const session of queued.slice(0, MAX_NEEDS_EXTRACTION)) {
    lines.push(
      `- \`${session?.key ?? "?"}\` ${oneLine(session?.title)} — ${session?.projectKey ?? "unclassified"} · ${sessionFacts(session)}`,
    );
  }
  pushOverflow(lines, queued.length - MAX_NEEDS_EXTRACTION, "session");
}

function pushExtracts(lines, bundle) {
  const withExtracts = asArray(bundle?.sessions).filter((session) => isObject(session?.extract));
  if (withExtracts.length === 0) return;
  lines.push("");
  lines.push(`## Sessions with cached extracts (${withExtracts.length})`);
  for (const session of withExtracts.slice(0, MAX_EXTRACTS)) {
    const extract = extractFields(session.extract);
    lines.push("");
    lines.push(`### \`${session?.key ?? "?"}\` ${oneLine(session?.title)}`);
    lines.push(
      `${session?.projectKey ?? "unclassified"} · ${sessionFacts(session)}` +
        (isText(extract.status) ? ` · status ${extract.status}` : ""),
    );
    for (const field of ["problem", "approach", "outcome"]) {
      if (isText(extract[field])) lines.push(`- ${field}: ${clamp(oneLine(extract[field]))}`);
    }
    const artifacts = asArray(extract.artifacts).filter(isText);
    if (artifacts.length > 0)
      lines.push(`- artifacts: ${artifacts.slice(0, 8).map(oneLine).join(", ")}`);
  }
  pushOverflow(lines, withExtracts.length - MAX_EXTRACTS, "extract");
}

// --- pieces -------------------------------------------------------------------------------------

// An extract file is a document that WRAPS the model's answer (`{cursor, history, extract:{…}}`),
// so the prose lives one level down. A flat object is accepted too, so a hand-written extract still
// renders instead of silently showing nothing.
function extractFields(extract) {
  return isObject(extract?.extract) ? extract.extract : (extract ?? {});
}

function sessionLine(session) {
  const signals = asArray(session?.signals).filter(isText).slice(0, MAX_SIGNALS);
  const tail = signals.length === 0 ? "" : ` — ${signals.map(oneLine).join("; ")}`;
  const excluded = isObject(session?.excluded)
    ? ` [excluded: ${session.excluded.reason}${isText(session.excluded.linkedTo) ? ` → ${session.excluded.linkedTo}` : ""}]`
    : "";
  return `\`${session?.key ?? "?"}\` ${oneLine(session?.title)} — ${sessionFacts(session)}${excluded}${tail}`;
}

function sessionFacts(session) {
  const parts = [`${count(session?.turnCount)} ${pluralize(count(session?.turnCount), "turn")}`];
  parts.push(`${formatDuration(count(session?.activeMs))} active`);
  if (count(session?.agentRuntimeMs) > 0)
    parts.push(`${formatHours(count(session.agentRuntimeMs))} agent`);
  if (count(session?.tokens) > 0) parts.push(`${formatNumber(count(session.tokens))} tokens`);
  const models = asArray(session?.models).filter(isText);
  if (models.length > 0) parts.push(models.join(", "));
  if (isText(session?.branch)) parts.push(`branch ${session.branch}`);
  return parts.join(" · ");
}

function topFiles(sessions) {
  const byPath = new Map();
  for (const session of sessions) {
    for (const file of asArray(session?.files)) {
      if (!isText(file?.path)) continue;
      const existing = byPath.get(file.path);
      if (existing === undefined) {
        byPath.set(file.path, {
          path: file.path,
          additions: count(file.additions),
          deletions: count(file.deletions),
        });
        continue;
      }
      existing.additions += count(file.additions);
      existing.deletions += count(file.deletions);
    }
  }
  return [...byPath.values()].sort(
    (left, right) =>
      right.additions + right.deletions - (left.additions + left.deletions) ||
      left.path.localeCompare(right.path),
  );
}

function pushOverflow(lines, remaining, noun) {
  if (remaining > 0) lines.push(`- … and ${remaining} more ${pluralize(remaining, noun)}`);
}

// An unknown project also classifies as `excluded`, but the two mean opposite things to a writer:
// one was switched off on purpose, the other has simply never been reviewed.
function classificationLabel(classification) {
  if (classification?.known === false) return "unclassified — do not name";
  const effective = isText(classification?.effective) ? classification.effective : "unknown";
  return classification?.counted === false ? `${effective} (not counted)` : effective;
}

function rangeLabel(range) {
  const from = isText(range?.from) ? range.from : "?";
  const to = isText(range?.to) ? range.to : from;
  return from === to ? from : `${from}..${to}`;
}

// Blocks carry UTC ISO stamps; a work log is read in local time, so the clock is rendered local.
function clock(iso, withDate) {
  const ms = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(ms)) return "??:??";
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  if (!withDate) return `${hh}:${mm}`;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}-${day} ${hh}:${mm}`;
}

function shortSha(sha) {
  return isText(sha) ? sha.slice(0, 7) : "?";
}

function plural(value, noun) {
  const n = count(value);
  return n > 0 ? `${n} ${pluralize(n, noun)}` : null;
}

function clamp(text) {
  return text.length <= EXTRACT_FIELD_MAX_CHARS
    ? text
    : `${text.slice(0, EXTRACT_FIELD_MAX_CHARS - 1)}…`;
}

// Markdown list items must stay on one line, and a stray newline in a title would silently break
// the structure the model is reading.
function oneLine(text) {
  return String(text ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isText(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
