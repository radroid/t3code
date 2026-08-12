// The privacy hard gate: the last thing between a draft work log and a public post.
//
// Two jobs live here because they share one catalogue of "shapes we do not publish":
//
//   lintText / lintFile — read a finished report and report what must not ship. Blocking.
//   redactSlice         — scrub a transcript slice on its way to disk or to a subagent.
//
// The asymmetry that decides every judgement call below: a false negative is unrecoverable (a
// client name, once posted, stays posted) while a false positive costs one edit. So everything
// unknown fails closed — a project the registry cannot vouch for is treated as private, an
// unreadable file is an error finding rather than a silent pass, and an internal failure
// withholds the slice instead of passing it through.
//
// The counterweight is noise: a gate a human learns to ignore is a gate that is off. That is why
// a match inside a higher-priority rule's span is dropped, why links to public code hosts are
// exempt from the path-shape rules, and why every finding carries a hint that says what to write
// instead.

import * as NodeFS from "node:fs";

import { homeDir as currentHomeDir } from "./paths.mjs";
import { classify, isNameable } from "./registry.mjs";

// Long enough to show the match in context, short enough that a wall of findings still scans.
const EXCERPT_MAX = 120;

// A mask never shows more than this many leading characters of what it is hiding.
const MASK_HEAD_MAX = 4;

// Fixed-width middle, so the mask does not advertise the length of a secret.
const MASK_BODY = "*".repeat(8);

const ELLIPSIS = "…";

// Column widths for `formatFindings`, kept together so a hint always lines up under its excerpt.
const POSITION_WIDTH = 8;
const SEVERITY_WIDTH = 5;

// A project term shorter than this is a word, not a name ("cli", "web"), and would fire on prose.
// Terms are matched as substrings (see `buildTermPatterns`), so a three-letter key would land in
// the middle of ordinary words too — this floor is what keeps that from drowning the gate.
const MIN_PROJECT_TERM = 4;

// A block of quoted text or code longer than this is a transcript dump, not a description.
const MAX_QUOTE_LINES = 3;

/** The rule catalogue, in precedence order: an earlier rule's span wins over a later one's. */
export const RULES = Object.freeze(
  [
    {
      id: "lint-unavailable",
      severity: "error",
      title: "The redaction gate could not run",
      hint: "Nothing was checked, so nothing is cleared — fix the error above and lint again.",
    },
    {
      id: "secret-shape",
      severity: "error",
      title: "Looks like a credential",
      hint: "Rotate it if it is real, then cut it. A work log never needs a token in it.",
    },
    {
      id: "redact-term",
      severity: "error",
      title: "A term on the always-redact list",
      hint: "Use the neutral phrase from config/redaction.yaml — that list exists for this.",
    },
    {
      id: "private-project",
      severity: "error",
      title: "Names a project that is not public",
      hint: 'Describe the work, not the client ("a client project"). If it really is public, set visibility: public and confirmed: true in config/projects.yaml.',
    },
    {
      id: "unclassified-project",
      severity: "error",
      title: "Names a project the registry has never classified",
      hint: "Nobody has reviewed this project, so it cannot be named — classify it in config/projects.yaml (visibility plus confirmed: true), or describe the work without it.",
    },
    {
      id: "email",
      severity: "error",
      title: "Email address",
      hint: "Drop it, or use a bare handle (@name). An address in a public post is a spam magnet.",
    },
    {
      id: "home-path",
      severity: "error",
      title: "Absolute path through a home directory",
      hint: "Use the file's basename — the tree above it names you and maps your machine.",
    },
    {
      id: "tilde-path",
      severity: "error",
      title: "Home-relative path",
      hint: "Use the basename. `~/…` still publishes your directory layout.",
    },
    {
      id: "private-branch",
      severity: "warn",
      title: "Branch name tied to a project that is not public",
      hint: "Branch names carry client and feature names; say what changed instead.",
    },
    {
      id: "raw-quote",
      severity: "warn",
      title: "A long quote or code block",
      hint: "The report describes outcomes, not transcripts — summarise it or link to the commit.",
    },
    {
      id: "long-path",
      severity: "warn",
      title: "Deep file path",
      hint: "Two segments is plenty (`lib/redact.mjs`); deeper reads as a filesystem dump.",
    },
  ].map((rule) => Object.freeze(rule)),
);

const RULE_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));
const PRECEDENCE = new Map(RULES.map((rule, index) => [rule.id, index]));

// Derived, not a literal: the first rule id longer than the old fixed 16 pushed every hint under
// it out of alignment, and nothing failed to say so.
const RULE_WIDTH = Math.max(...RULES.map((rule) => rule.id.length));
const EXCERPT_INDENT = " ".repeat(2 + POSITION_WIDTH + SEVERITY_WIDTH + 2 + RULE_WIDTH + 2);

// The rule a caller-supplied term falls back to. `extraTerms` exists to police projects the
// registry has never heard of, so an entry that forgets its rule id fails closed into that one.
const DEFAULT_EXTRA_RULE = "unclassified-project";

// `raw-quote` is structural: its span is a block, not a leak. That keeps it out of the containment
// pass in both directions (a secret inside a fence must still be reported, and a fence around a
// secret must still be reported) and out of the mask set (or every excerpt inside a fence would
// be a solid row of asterisks).
const STRUCTURAL_RULES = new Set(["raw-quote"]);

// Only the shape rules are waived inside a public code-host link. A credential in a URL is still
// a credential, so `secret-shape`, `email` and the name rules are never waived.
const URL_EXEMPT_RULES = new Set(["long-path", "private-branch"]);

// A link to a public PR is the point of the report, so these hosts are not treated as leaks.
const PUBLIC_CODE_HOSTS = [
  "github.com",
  "githubusercontent.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "sr.ht",
  "npmjs.com",
  "pypi.org",
  "crates.io",
  "pkg.go.dev",
  "hex.pm",
];

// Characters that can appear inside a path token. Deliberately excludes the punctuation a
// sentence ends with, so "…/redact.mjs." does not swallow the full stop.
const PATH_CHARS = "A-Za-z0-9._~@+%\\-";

const URL_PATTERN = /https?:\/\/[^\s<>()[\]"'`]+/gu;

const TILDE_PATH_PATTERN = new RegExp(
  `(?<![${PATH_CHARS}])~\\/[${PATH_CHARS}]+(?:\\/[${PATH_CHARS}]*)*`,
  "gu",
);

// Any user's home, not only this machine's: a report drafted on one box is often linted on
// another, and `/Users/someone-else/…` leaks a person either way.
const GENERIC_HOME_PATTERNS = [
  new RegExp(`(?<![${PATH_CHARS}])\\/Users\\/[${PATH_CHARS}]+(?:\\/[${PATH_CHARS}]*)*`, "gu"),
  new RegExp(`(?<![${PATH_CHARS}])\\/home\\/[${PATH_CHARS}]+(?:\\/[${PATH_CHARS}]*)*`, "gu"),
];

const EMAIL_PATTERN =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu;

// Three or more slash-separated segments with no whitespace: a path, not a fraction. The
// lookbehind deliberately allows a leading `/`, so the path part of a URL is a candidate too —
// that is the match the public-code-host exemption exists to waive.
const LONG_PATH_PATTERN = new RegExp(
  `(?<![${PATH_CHARS}])(?:[${PATH_CHARS}]+\\/){2,}[${PATH_CHARS}]*`,
  "gu",
);

// One or two slashes: `feat/x`, `fix/y`, `owner/repo`. The trailing lookahead stops a deep path
// from being read as a branch, but still allows the sentence punctuation after one.
const BRANCH_PATTERN = new RegExp(
  `(?<![${PATH_CHARS}\\/])(?:[A-Za-z0-9][A-Za-z0-9._\\-]*\\/){1,2}[A-Za-z0-9][A-Za-z0-9._\\-]*(?![A-Za-z0-9\\/])`,
  "gu",
);

// A branch's last segment does not normally end in a letters-only extension; a file's does.
// Digits are left alone so `release/v1.2.3` still reads as a branch.
const FILE_EXTENSION_TAIL = /\.[A-Za-z]{1,4}$/u;

// The assignment keys that introduce a credential. Enumerated in full rather than allowed a
// trailing wildcard: `authorization` has to be spelled out because `auth\w*` would also fire on
// "Authors:" and "Authored:", and a gate that flags a byline is a gate a human turns off.
const SECRET_KEYS =
  "password|passwd|secret|api[_-]?key|apikey|token|authorization|auth|credentials?|passphrase|private[_-]?key";

// An HTTP auth scheme sits between the key and the value; skipping it is what keeps the mask on
// the credential instead of on the word "Basic". These are only recognised after a key, because
// "Basic understanding" is ordinary prose.
const AUTH_SCHEMES = "Bearer|Basic|Token|Digest";

// `group` is the capture index holding the part worth hiding, so `password=` stays readable in
// the excerpt while its value does not.
const SECRET_PATTERNS = [
  { re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/gu },
  { re: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{16,}/gu },
  { re: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/gu },
  { re: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/gu },
  { re: /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/gu },
  { re: /(?<![A-Za-z0-9])glpat-[0-9A-Za-z_-]{20,}/gu },
  // The published lengths are exact (`AIza` + 35, `npm_` + 36, `dop_v1_` + 64) but the quantifiers
  // are open-ended on purpose: a trailing bound would let a longer lookalike match nothing at all,
  // and it is the whole run that has to disappear from the file.
  { re: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35,}/gu },
  { re: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36,}/gu },
  { re: /(?<![A-Za-z0-9])dop_v1_[a-f0-9]{64,}/gu },
  // A JWT: base64url header (always starting `eyJ`), payload, signature. Matching past the first
  // dot is what removes the payload — the half that carries the claims.
  { re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*)?/gu },
  { re: /\bBearer[ \t]+([A-Za-z0-9._~+/=-]{8,})/gu, group: 1 },
  { re: /-{0,5}BEGIN[A-Z ]*PRIVATE KEY-{0,5}/gu },
  { re: /(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/gu },
  {
    re: new RegExp(
      `[A-Za-z0-9_-]{0,24}(?:${SECRET_KEYS})["']?[ \t]*[:=][ \t]*["']?(?:(?:${AUTH_SCHEMES})[ \t]+)?([^\\s"'\`,;]{3,})`,
      "giu",
    ),
    group: 1,
  },
];

const BLOCKQUOTE_LINE = /^ {0,3}>/u;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/u;

/**
 * Every finding in `text`, sorted by line then column; never throws.
 *
 * `lintText(text, { registry, redaction, homeDir, allow, extraTerms })`, where `extraTerms` is
 * `[{ term, rule }]` — terms the caller wants blocked that the registry cannot know about,
 * each reported under its own rule id at `error` severity.
 */
export function lintText(text, options = {}) {
  try {
    if (typeof text !== "string" || text === "") return [];
    const context = buildContext(options);
    const allow = new Set(toTextArray(options?.allow));

    const exempt = exemptUrlSpans(text, context);
    const eligible = collectCandidates(text, context).filter(
      (c) => !(URL_EXEMPT_RULES.has(c.rule) && isWithinAny(c, exempt)),
    );

    // Every excerpt masks every sensitive span it happens to cross, not just its own match —
    // otherwise a line with two leaks on it publishes the second one in the first one's excerpt.
    // `allow` deliberately does not unmask: it says "do not fail on this", not "print it".
    const maskSpans = mergeSpans(
      eligible
        .filter((c) => !STRUCTURAL_RULES.has(c.rule))
        .map((c) => ({ start: c.maskStart, end: c.maskEnd })),
    );

    const lineStarts = lineStartsOf(text);
    return suppressNested(eligible.filter((c) => !allow.has(c.rule)))
      .map((candidate) => toFinding(text, lineStarts, candidate, maskSpans))
      .sort((a, b) => a.line - b.line || a.column - b.column || rank(a.rule) - rank(b.rule));
  } catch (error) {
    // The gate failing open would be the one unrecoverable bug in this module.
    return [unavailableFinding(describeError(error, options))];
  }
}

/**
 * The findings for a file on disk, each carrying `filePath`; an unreadable file is an error.
 * Takes the same options as `lintText`, `extraTerms` included.
 */
export function lintFile(filePath, opts = {}) {
  let text;
  try {
    text = NodeFS.readFileSync(filePath, "utf8");
  } catch (error) {
    const reason = `${error?.code ?? "unreadable"}: ${basenameOnly(filePath)}`;
    return [{ filePath: asText(filePath), ...unavailableFinding(reason) }];
  }
  return lintText(text, opts).map((finding) => ({ filePath: asText(filePath), ...finding }));
}

/** True when any finding is blocking — the exit-code question for `worklog lint`. */
export function hasErrors(findings) {
  if (!Array.isArray(findings)) return false;
  return findings.some((finding) => finding?.severity === "error");
}

/** A multi-line, human-readable rendering of findings; safe to print as-is. */
export function formatFindings(findings) {
  const list = Array.isArray(findings) ? findings.filter(isPlainObject) : [];
  if (list.length === 0) return "No redaction findings.";

  const errors = list.filter((finding) => finding.severity === "error").length;
  const warnings = list.length - errors;
  const lines = [`${plural(errors, "error")}, ${plural(warnings, "warning")}`];

  const groups = new Map();
  for (const finding of list) {
    const file = asText(finding.filePath);
    if (!groups.has(file)) groups.set(file, []);
    groups.get(file).push(finding);
  }

  // A hint repeated twenty times is a hint nobody reads, so each rule explains itself once.
  const explained = new Set();
  for (const [file, group] of groups) {
    lines.push("");
    if (file !== "") lines.push(file);
    for (const finding of group) {
      const at = `${finding.line ?? 1}:${finding.column ?? 1}`.padEnd(POSITION_WIDTH, " ");
      const severity = asText(finding.severity).padEnd(SEVERITY_WIDTH, " ");
      const rule = asText(finding.rule).padEnd(RULE_WIDTH, " ");
      lines.push(`  ${at}${severity}  ${rule}  ${asText(finding.excerpt)}`.trimEnd());
      const hint = asText(finding.hint);
      if (hint !== "" && !explained.has(finding.rule)) {
        explained.add(finding.rule);
        lines.push(`${EXCERPT_INDENT}hint: ${hint}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Scrubs a transcript slice before it is written to disk or handed to a subagent. Idempotent:
 * every replacement is a fixed point, so re-scrubbing a scrubbed slice changes nothing.
 */
export function redactSlice(text, options = {}) {
  if (typeof text !== "string" || text === "") return "";
  try {
    const home = resolveHome(options?.homeDir);
    let out = text;
    // Paths first: a key sitting in a directory name disappears with the directory, and a
    // replacement token like `[redacted]` would otherwise break the path match around it.
    out = reducePaths(out, home);
    out = replaceSecrets(out);
    out = replaceAll(out, EMAIL_PATTERN, () => "[redacted]");
    out = replaceTerms(out, options?.redaction);
    return out;
  } catch {
    // Returning the input would defeat the point of calling this at all.
    return "[worklog: redaction failed — slice withheld]";
  }
}

/** The last segment of a path — the only part of a location a report may safely carry. */
export function basenameOnly(p) {
  if (typeof p !== "string") return "";
  const trimmed = p.trim();
  if (trimmed === "") return "";
  const normalised = trimmed.replace(/\\/gu, "/").replace(/\/+$/u, "");
  if (normalised === "") return "/";
  const base = normalised.slice(normalised.lastIndexOf("/") + 1);
  return base === "" ? normalised : base;
}

// --- context ------------------------------------------------------------------------------------

function buildContext(options) {
  const home = resolveHome(options?.homeDir);
  const termPatterns = buildTermPatterns(alwaysRedactOf(options?.redaction));
  const projectPatterns = buildTermPatterns(nonPublicProjectTerms(options?.registry));
  return {
    homePatterns: buildHomePatterns(home),
    termPatterns,
    projectPatterns,
    extraPatterns: buildExtraPatterns(options?.extraTerms),
    // Whether a branch is "attributable" is decided against the same terms, so a project that is
    // safe to name never arms this rule.
    hasPrivateProjects: projectPatterns.length > 0,
  };
}

function resolveHome(value) {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  try {
    return currentHomeDir();
  } catch {
    return "";
  }
}

function buildHomePatterns(home) {
  const patterns = [...GENERIC_HOME_PATTERNS];
  // A home of "/" or "~" would turn every slash into a finding.
  if (typeof home === "string" && home.length >= 4 && home.includes("/")) {
    patterns.unshift(new RegExp(`${escapeRegExp(home)}(?:\\/[${PATH_CHARS}]*)*`, "gu"));
  }
  return patterns;
}

function alwaysRedactOf(redaction) {
  if (!isPlainObject(redaction)) return [];
  // `alwaysRedact` is the camelCase form registry.loadRedaction returns; the snake_case spelling
  // is accepted too so a hand-built options object from the raw YAML still works.
  return toTextArray(redaction.alwaysRedact ?? redaction.always_redact);
}

function replacementsOf(redaction) {
  if (!isPlainObject(redaction)) return {};
  return isPlainObject(redaction.replacements) ? redaction.replacements : {};
}

// The registry owns the visibility policy; this only asks it a yes/no question per project and
// treats every other answer — including a throw — as "not public".
function nonPublicProjectTerms(registry) {
  if (!isPlainObject(registry) || !isPlainObject(registry.projects)) return [];
  const terms = [];
  for (const key of Object.keys(registry.projects)) {
    let classification = null;
    try {
      classification = classify(registry, key);
    } catch {
      classification = null;
    }
    if (isNameable(classification)) continue;

    const entry = isPlainObject(registry.projects[key]) ? registry.projects[key] : {};
    terms.push(key, entry.displayName, entry.display_name);
    const roots = Array.isArray(entry.roots) ? entry.roots : [];
    for (const root of roots) terms.push(basenameOnly(root));
  }
  return terms.filter((term) => typeof term === "string" && term.trim().length >= MIN_PROJECT_TERM);
}

// Every term is matched as a substring, whether or not it looks like a word. `northwind` fires
// inside `northwindretail-prod`, which is exactly how a client name reaches a public post; word
// boundaries used to let that through. The cost is a false positive the human edits away, and
// `reference/privacy.md` documents the behaviour so the list is curated against what happens.
// Internal whitespace matches any run of it, so a term split across a line wrap still matches.
function buildTermPatterns(terms) {
  const patterns = [];
  const seen = new Set();
  for (const raw of toTextArray(terms)) {
    const term = raw.trim();
    const fingerprint = term.toLowerCase();
    if (term === "" || seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const source = term
      .split(/\s+/u)
      .map((word) => escapeRegExp(word))
      .join("\\s+");
    try {
      patterns.push({ term, re: new RegExp(source, "giu") });
    } catch {
      // An unrepresentable term is dropped rather than taking the whole gate down with it.
    }
  }
  return patterns;
}

// Terms the caller supplies per lint, each carrying the rule id it is reported under. The registry
// can only police projects it knows about, so this is the only way an unclassified project — the
// one class that must never be named — reaches the gate at all.
function buildExtraPatterns(entries) {
  if (!Array.isArray(entries)) return [];
  const patterns = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;
    const term = asText(entry.term).trim();
    if (term === "") continue;
    const rule = asText(entry.rule).trim() || DEFAULT_EXTRA_RULE;
    for (const { re } of buildTermPatterns([term])) patterns.push({ rule, re });
  }
  return patterns;
}

// --- candidate collection -----------------------------------------------------------------------

function collectCandidates(text, context) {
  const candidates = [];
  const lines = lineSpansOf(text);

  for (const { re, group } of SECRET_PATTERNS) {
    eachMatch(re, text, (match) => {
      const span = groupSpan(match, group);
      candidates.push(candidate("secret-shape", match.index, match.index + match[0].length, span));
    });
  }

  for (const { re } of context.termPatterns) {
    eachMatch(re, text, (match) => {
      candidates.push(candidate("redact-term", match.index, match.index + match[0].length));
    });
  }

  const privateHits = [];
  for (const { re } of context.projectPatterns) {
    eachMatch(re, text, (match) => {
      const start = match.index;
      const end = start + match[0].length;
      privateHits.push({ start, end });
      candidates.push(candidate("private-project", start, end));
    });
  }

  for (const { rule, re } of context.extraPatterns) {
    eachMatch(re, text, (match) => {
      candidates.push({
        // Always blocking, and always explained: the caller may name a rule this module has never
        // heard of, but "unreviewed project" is the only reason it has to hand one over.
        ...candidate(rule, match.index, match.index + match[0].length),
        severity: "error",
        hint: RULE_BY_ID.get(rule)?.hint ?? RULE_BY_ID.get(DEFAULT_EXTRA_RULE).hint,
      });
    });
  }

  eachMatch(EMAIL_PATTERN, text, (match) => {
    candidates.push(candidate("email", match.index, match.index + match[0].length));
  });

  for (const re of context.homePatterns) {
    eachMatch(re, text, (match) => {
      addPathCandidate(candidates, "home-path", text, match);
    });
  }

  eachMatch(TILDE_PATH_PATTERN, text, (match) => {
    addPathCandidate(candidates, "tilde-path", text, match);
  });

  addBranchCandidates(text, context, privateHits, candidates);
  addQuoteCandidates(text, lines, candidates);

  eachMatch(LONG_PATH_PATTERN, text, (match) => {
    addPathCandidate(candidates, "long-path", text, match);
  });

  return candidates;
}

// Path rules mask everything above the basename: that is where the username and the tree live,
// and leaving the filename visible is what makes the finding actionable.
function addPathCandidate(candidates, rule, text, match) {
  const start = match.index;
  const end = trimTrailingPunctuation(text, start, start + match[0].length);
  if (end - start < 2) return;
  const body = text.slice(start, end);
  const lastSlash = body.lastIndexOf("/");
  const maskEnd = lastSlash > 0 ? start + lastSlash : end;
  candidates.push(candidate(rule, start, end, { start, end: maskEnd }));
}

function addBranchCandidates(text, context, privateHits, candidates) {
  if (!context.hasPrivateProjects) return;
  const urlSpans = allUrlSpans(text);
  const lineStarts = lineStartsOf(text);

  eachMatch(BRANCH_PATTERN, text, (match) => {
    const start = match.index;
    const end = trimTrailingPunctuation(text, start, start + match[0].length);
    const token = text.slice(start, end);
    if (FILE_EXTENSION_TAIL.test(token.slice(token.lastIndexOf("/") + 1))) return;
    // A repo path inside a URL is a link, not a branch; the URL rules cover it.
    if (isWithinAny({ start, end }, urlSpans)) return;

    const lineIndex = lineIndexAt(lineStarts, start);
    const lineStart = lineStarts[lineIndex];
    const lineEnd = lineIndex + 1 < lineStarts.length ? lineStarts[lineIndex + 1] : text.length;
    const attributable =
      matchesAnyTerm(token, context.projectPatterns) ||
      privateHits.some((hit) => hit.start >= lineStart && hit.end <= lineEnd);
    if (!attributable) return;
    candidates.push(candidate("private-branch", start, end));
  });
}

function addQuoteCandidates(text, lines, candidates) {
  let index = 0;
  while (index < lines.length) {
    const fence = FENCE_LINE.exec(lines[index].text);
    if (fence !== null) {
      const marker = fence[1];
      const info = sanitiseInfoString(fence[2]);
      let end = index + 1;
      while (end < lines.length && !isClosingFence(lines[end].text, marker)) end += 1;
      const contentLines = end - index - 1;
      if (contentLines > MAX_QUOTE_LINES) {
        const last = Math.min(end, lines.length - 1);
        candidates.push({
          ...candidate("raw-quote", lines[index].start, lines[last].end),
          excerpt: `fenced block${info === "" ? "" : ` (${info})`} — ${plural(contentLines, "line")}`,
        });
      }
      index = end + 1;
      continue;
    }

    if (BLOCKQUOTE_LINE.test(lines[index].text)) {
      let end = index;
      while (end + 1 < lines.length && BLOCKQUOTE_LINE.test(lines[end + 1].text)) end += 1;
      const quoted = end - index + 1;
      if (quoted > MAX_QUOTE_LINES) {
        candidates.push({
          ...candidate("raw-quote", lines[index].start, lines[end].end),
          excerpt: `blockquote — ${plural(quoted, "line")}`,
        });
      }
      index = end + 1;
      continue;
    }
    index += 1;
  }
}

function isClosingFence(line, marker) {
  const match = FENCE_LINE.exec(line);
  if (match === null) return false;
  return match[1][0] === marker[0] && match[1].length >= marker.length && match[2] === "";
}

function sanitiseInfoString(info) {
  return asText(info)
    .replace(/[^A-Za-z0-9+#._-]/gu, "")
    .slice(0, 20);
}

function candidate(rule, start, end, mask) {
  const span = isPlainObject(mask) ? mask : { start, end };
  return {
    rule,
    severity: RULE_BY_ID.get(rule)?.severity ?? "error",
    start,
    end,
    maskStart: span.start,
    maskEnd: span.end,
  };
}

// --- link exemption -------------------------------------------------------------------------------

function allUrlSpans(text) {
  const spans = [];
  eachMatch(URL_PATTERN, text, (match) => {
    spans.push({ start: match.index, end: match.index + match[0].length, url: match[0] });
  });
  return spans;
}

// A public code-host link is exempt from the shape rules — unless the link itself names something
// private, in which case the link is the leak.
function exemptUrlSpans(text, context) {
  return allUrlSpans(text).filter((span) => {
    if (!isPublicCodeHost(hostOf(span.url))) return false;
    if (matchesAnyTerm(span.url, context.projectPatterns)) return false;
    if (matchesAnyTerm(span.url, context.termPatterns)) return false;
    return true;
  });
}

function hostOf(url) {
  const match = /^https?:\/\/(?:[^/@\s]*@)?([^/?#:\s]+)/iu.exec(asText(url));
  return match === null ? "" : match[1].toLowerCase();
}

function isPublicCodeHost(host) {
  if (host === "") return false;
  return PUBLIC_CODE_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}

// --- suppression ----------------------------------------------------------------------------------

// Higher-precedence rules are placed first, so anything they already cover is dropped rather than
// reported twice. Containment is the only test: a warning that *contains* an error (a branch name
// built from a private project) is still worth its own line, because fixing the error does not
// fix the branch.
function suppressNested(candidates) {
  const ordered = [...candidates].sort(
    (a, b) =>
      rank(a.rule) - rank(b.rule) || a.start - b.start || b.end - b.start - (a.end - a.start),
  );
  const kept = [];
  for (const item of ordered) {
    if (STRUCTURAL_RULES.has(item.rule)) {
      kept.push(item);
      continue;
    }
    const covered = kept.some(
      (other) =>
        !STRUCTURAL_RULES.has(other.rule) && other.start <= item.start && other.end >= item.end,
    );
    if (!covered) kept.push(item);
  }
  return kept;
}

/** Overlapping spans merged into a disjoint, ordered list, so masks never nest. */
function mergeSpans(spans) {
  const sorted = spans
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

function rank(rule) {
  return PRECEDENCE.get(rule) ?? RULES.length;
}

// --- findings ---------------------------------------------------------------------------------------

function toFinding(text, lineStarts, item, maskSpans) {
  const lineIndex = lineIndexAt(lineStarts, item.start);
  const lineStart = lineStarts[lineIndex];
  const lineEnd = lineIndex + 1 < lineStarts.length ? lineStarts[lineIndex + 1] - 1 : text.length;
  const rule = RULE_BY_ID.get(item.rule);
  return {
    rule: item.rule,
    severity: item.severity,
    line: lineIndex + 1,
    column: item.start - lineStart + 1,
    excerpt:
      typeof item.excerpt === "string"
        ? clipAround(flatten(item.excerpt), 0, 0, EXCERPT_MAX)
        : buildExcerpt(text, lineStart, lineEnd, item, maskSpans),
    hint: asText(item.hint) || rule?.hint || "",
  };
}

function buildExcerpt(text, lineStart, lineEnd, item, maskSpans) {
  const flat = flatten(text.slice(lineStart, lineEnd));
  const own = clamp(item.maskStart - lineStart, 0, flat.length);

  let rendered = "";
  let cursor = 0;
  let focusStart = 0;
  let focusEnd = 0;
  let focused = false;
  for (const span of maskSpans) {
    const start = clamp(span.start - lineStart, 0, flat.length);
    const end = clamp(span.end - lineStart, start, flat.length);
    if (end <= cursor) continue;
    rendered += flat.slice(cursor, start);
    const masked = maskSecret(flat.slice(start, end));
    if (!focused && start <= own && own <= end) {
      focusStart = rendered.length;
      focusEnd = focusStart + masked.length;
      focused = true;
    }
    rendered += masked;
    cursor = end;
  }
  rendered += flat.slice(cursor);

  const spansLines = item.end > lineEnd;
  const limit = EXCERPT_MAX - (spansLines ? ELLIPSIS.length : 0);
  const clipped = clipAround(rendered, focusStart, focusEnd, limit).trimEnd();
  return spansLines && !clipped.endsWith(ELLIPSIS) ? `${clipped}${ELLIPSIS}` : clipped;
}

/** Hides the middle of a matched secret, keeping just enough of the head to locate it. */
function maskSecret(s) {
  if (s.length === 0) return "";
  if (s.length <= 2) return "*".repeat(s.length);
  const head = Math.min(MASK_HEAD_MAX, Math.max(1, Math.floor(s.length / 4)));
  const masked = `${s.slice(0, head)}${MASK_BODY.slice(0, Math.min(s.length - head, MASK_BODY.length))}`;
  // Insurance against a pathological input (a match made of asterisks) reconstituting itself.
  return masked.includes(s) ? "[redacted]" : masked;
}

function clipAround(s, focusStart, focusEnd, limit) {
  if (s.length <= limit) return s;
  const budget = Math.max(1, limit - 2 * ELLIPSIS.length);
  const focus = Math.max(1, focusEnd - focusStart);
  let start = Math.max(0, focusStart - Math.max(0, Math.floor((budget - focus) / 2)));
  let end = Math.min(s.length, start + budget);
  start = Math.max(0, end - budget);
  const head = start > 0 ? ELLIPSIS : "";
  const tail = end < s.length ? ELLIPSIS : "";
  return `${head}${s.slice(start, end)}${tail}`;
}

function unavailableFinding(detail) {
  const rule = RULE_BY_ID.get("lint-unavailable");
  return {
    rule: rule.id,
    severity: rule.severity,
    line: 1,
    column: 1,
    excerpt: clipAround(flatten(asText(detail) || "internal error"), 0, 0, EXCERPT_MAX),
    hint: rule.hint,
  };
}

// An error message can carry the very path the gate exists to hide, so it is scrubbed before it
// is allowed into a finding.
function describeError(error, options) {
  const message = asText(error?.message) || String(error ?? "internal error");
  try {
    return redactSlice(message, { homeDir: options?.homeDir, redaction: options?.redaction });
  } catch {
    return "internal error";
  }
}

// --- redaction --------------------------------------------------------------------------------------

function reducePaths(text, home) {
  let out = text;
  if (typeof home === "string" && home.length >= 4 && home.includes("/")) {
    const homePattern = new RegExp(`${escapeRegExp(home)}(?:\\/[${PATH_CHARS}]*)*`, "gu");
    out = replaceAll(out, homePattern, (matched) => {
      const rest = matched.slice(home.length).replace(/^\/+/u, "");
      return rest === "" ? "~" : basenameOnly(rest);
    });
  }
  // Any other absolute path, but only where it is not the tail of a URL (`https://host/a/b`).
  const absolute = new RegExp(
    `(?<![${PATH_CHARS}:\\/])\\/(?:[${PATH_CHARS}]+\\/)+[${PATH_CHARS}]*`,
    "gu",
  );
  out = replaceAll(out, absolute, (matched) => basenameOnly(matched) || "/");
  const tilde = new RegExp(
    `(?<![${PATH_CHARS}])~\\/[${PATH_CHARS}]+(?:\\/[${PATH_CHARS}]*)*`,
    "gu",
  );
  return replaceAll(out, tilde, (matched) => basenameOnly(matched.slice(2)) || "~");
}

function replaceSecrets(text) {
  let out = text;
  for (const { re, group } of SECRET_PATTERNS) {
    out = replaceGroup(out, re, group);
  }
  return out;
}

function replaceTerms(text, redaction) {
  const terms = alwaysRedactOf(redaction);
  const replacements = replacementsOf(redaction);
  const patterns = buildTermPatterns(terms);
  const lookup = new Map();
  for (const [term, value] of Object.entries(replacements)) {
    if (typeof value !== "string") continue;
    lookup.set(term.trim().toLowerCase(), value);
  }

  let out = text;
  for (const { term, re } of patterns) {
    const configured = lookup.get(term.toLowerCase());
    // A replacement that still contains a redacted term would make this non-idempotent (and
    // would not redact anything), so it loses to the generic marker.
    const safe =
      typeof configured === "string" &&
      configured.trim() !== "" &&
      !patterns.some(({ re: other }) => testOnce(other, configured))
        ? configured
        : "[redacted]";
    out = replaceAll(out, re, () => safe);
  }
  return out;
}

// --- regex plumbing ------------------------------------------------------------------------------------

// Every scan clones its pattern: a module-level /g regex carries `lastIndex` between calls, which
// would make the gate's results depend on what it looked at previously.
function eachMatch(re, text, fn) {
  const pattern = cloneRegExp(re, { global: true, indices: true });
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0] === "") {
      pattern.lastIndex += 1;
      continue;
    }
    fn(match);
  }
}

function replaceAll(text, re, build) {
  const pattern = cloneRegExp(re, { global: true });
  // A function replacement keeps `$&`-style sequences in configured text from being expanded.
  return text.replace(pattern, (...args) => build(args[0]));
}

function replaceGroup(text, re, group) {
  if (!group) return replaceAll(text, re, () => "[redacted]");
  const pattern = cloneRegExp(re, { global: true, indices: true });
  let out = "";
  let cursor = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0] === "") {
      pattern.lastIndex += 1;
      continue;
    }
    const span = match.indices?.[group];
    if (span === undefined) continue;
    out += text.slice(cursor, span[0]) + "[redacted]";
    cursor = span[1];
  }
  return out + text.slice(cursor);
}

function testOnce(re, text) {
  return cloneRegExp(re, { global: false }).test(text);
}

function matchesAnyTerm(text, patterns) {
  return patterns.some(({ re }) => testOnce(re, text));
}

function cloneRegExp(re, { global = false, indices = false } = {}) {
  const flags = new Set(re.flags.replace("g", "").replace("d", ""));
  if (global) flags.add("g");
  if (indices) flags.add("d");
  return new RegExp(re.source, [...flags].join(""));
}

function groupSpan(match, group) {
  if (!group) return undefined;
  const span = match.indices?.[group];
  if (span === undefined) return undefined;
  return { start: span[0], end: span[1] };
}

// Only the syntax characters: in `u` mode an identity escape like `\-` outside a character class
// is a SyntaxError, so over-escaping here would take out every term pattern.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// --- text plumbing ----------------------------------------------------------------------------------------

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineSpansOf(text) {
  const starts = lineStartsOf(text);
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] - 1 : text.length;
    return { start, end, text: text.slice(start, end).replace(/\r$/u, "") };
  });
}

function lineIndexAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

function trimTrailingPunctuation(text, start, end) {
  let cursor = end;
  while (cursor > start + 1 && ".,;:!?)]}'\"".includes(text[cursor - 1])) cursor -= 1;
  return cursor;
}

// Control characters are replaced one-for-one so every offset computed on the raw line still
// points at the same character in the flattened one.
function flatten(s) {
  return s.replace(/\p{Cc}/gu, " ");
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function asText(value) {
  return typeof value === "string" ? value : "";
}

function toTextArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string" && entry.trim() !== "");
}

function isWithinAny(span, spans) {
  return spans.some((other) => span.start >= other.start && span.end <= other.end);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
