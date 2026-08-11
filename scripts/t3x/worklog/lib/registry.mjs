// The project registry: which projects exist, whether they may be named, and the tuning knobs.
//
// This module is the only thing that knows the on-disk config shape. Two rules drive its design:
//
// 1. Reading never throws. A missing, unreadable or malformed config must degrade to an empty
//    registry plus a warning, because `worklog doctor` and `worklog collect` have to keep working
//    on a machine where the worklog repo has not been created yet.
// 2. Privacy fails closed. An unknown project is `excluded`, an unconfirmed one is `unconfirmed`,
//    and an unrecognised visibility degrades to `generic` — never to `public`. Everything that
//    decides whether a name reaches a published report goes through `classify()`.
//
// YAML is snake_case (it is hand-edited); JS is camelCase. The translation happens here and
// nowhere else, so no other module has to remember which side it is on.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expandHome, isUnder, slugify, worklogPaths } from "./paths.mjs";
import { parseYaml, stringifyYaml, YamlLiteError } from "./yamlLite.mjs";

/** Tuning knobs used when the registry does not override them. */
export const DEFAULT_SETTINGS = Object.freeze({ activeGapMinutes: 30, singleEventMinutes: 1 });

const YAML_TO_JS = new Map([
  ["display_name", "displayName"],
  ["active_gap_minutes", "activeGapMinutes"],
  ["single_event_minutes", "singleEventMinutes"],
  ["always_redact", "alwaysRedact"],
]);

const JS_TO_YAML = new Map([...YAML_TO_JS].map(([yaml, js]) => [js, yaml]));

// Canonical field order for a project entry, so a saved file reads the same way every time.
const PROJECT_FIELD_ORDER = [
  "displayName",
  "roots",
  "include",
  "visibility",
  "confirmed",
  "link",
  "blurb",
];

// Both spellings of every known field, so a save cannot emit a camelCase key next to its
// snake_case twin when a caller hands us a half-normalised object.
const SETTINGS_FIELDS = [
  ...Object.keys(DEFAULT_SETTINGS),
  "active_gap_minutes",
  "single_event_minutes",
];
const PROJECT_FIELDS = [...PROJECT_FIELD_ORDER, "display_name"];

const VISIBILITIES = new Set(["public", "generic", "private"]);

const REGISTRY_HEADER = [
  "# /worklog project registry — which projects appear in a report, and how.",
  "#",
  "#   include: false      leave the project out of the report entirely",
  "#   visibility: public  named, with its link",
  '#   visibility: generic described anonymously ("a client project")',
  "#   visibility: private counted in the totals, never described",
  "#   confirmed: false    treated as private, and flagged in the report header",
  "#",
  "# Anything not listed here is excluded until you classify it.",
  "",
].join("\n");

const REGISTRY_COMMENTS = {
  identities: "Git author names and emails whose commits count as mine.",
  defaults: "Time-clustering knobs. activeGapMinutes splits the day into activity blocks.",
  projects: "One entry per project. Add roots so sessions and repos can be matched to it.",
};

const REDACTION_HEADER = [
  "# /worklog redaction list — terms `worklog lint` refuses to let through.",
  "#",
  "# always_redact: matched case-insensitively anywhere in a report.",
  "# replacements:  term -> the neutral phrase to use instead.",
  "",
].join("\n");

const REDACTION_COMMENTS = {
  always_redact: "Never let these appear in a published report.",
  replacements: "What to say instead.",
};

/** Reads `config/projects.yaml`; a missing or malformed file yields an empty registry + warnings. */
export function loadRegistry(paths) {
  const warnings = [];
  const file = resolvePaths(paths).projectsYaml;
  const doc = readYamlFile(file, "project registry", warnings);
  if (doc === null) return { registry: emptyRegistry(), warnings };
  return { registry: normaliseRegistry(doc, warnings), warnings };
}

/** Writes `config/projects.yaml` with an explanatory header; throws only if the write fails. */
export function saveRegistry(paths, registry) {
  const file = resolvePaths(paths).projectsYaml;
  const source = isPlainObject(registry) ? registry : emptyRegistry();

  const doc = {};
  doc.version = typeof source.version === "number" ? source.version : 1;
  doc.identities = identitiesOf(source);
  doc.defaults = toYamlKeys({
    ...settingsOf(source),
    ...extraKeys(source.defaults, SETTINGS_FIELDS),
  });

  const projects = {};
  const sourceProjects = isPlainObject(source.projects) ? source.projects : {};
  for (const key of Object.keys(sourceProjects)) {
    const entry = isPlainObject(sourceProjects[key]) ? sourceProjects[key] : {};
    const ordered = {};
    for (const field of PROJECT_FIELD_ORDER) {
      if (field === "roots") {
        ordered.roots = Array.isArray(entry.roots) ? [...entry.roots] : [];
        continue;
      }
      if (entry[field] !== undefined) ordered[field] = entry[field];
    }
    Object.assign(ordered, extraKeys(entry, PROJECT_FIELDS));
    setOwn(projects, key, toYamlKeys(ordered));
  }
  doc.projects = projects;

  // Anything a human added by hand at the top level survives a rewrite.
  Object.assign(doc, extraKeys(source, ["version", "identities", "defaults", "projects"]));

  writeYamlFile(file, REGISTRY_HEADER, doc, REGISTRY_COMMENTS);
  return file;
}

/** Reads `config/redaction.yaml`; a missing or malformed file yields empty lists + warnings. */
export function loadRedaction(paths) {
  const warnings = [];
  const file = resolvePaths(paths).redactionYaml;
  const redaction = { alwaysRedact: [], replacements: {} };
  const doc = readYamlFile(file, "redaction list", warnings);
  if (doc === null) return { redaction, warnings };

  const camel = toJsKeys(doc);
  redaction.alwaysRedact = normaliseTerms(camel.alwaysRedact, "always_redact", warnings);

  if (camel.replacements !== undefined && camel.replacements !== null) {
    if (!isPlainObject(camel.replacements)) {
      warnings.push(`"replacements" in ${file} must be a map of term -> replacement; ignoring it.`);
    } else {
      for (const [term, replacement] of Object.entries(camel.replacements)) {
        if (typeof replacement !== "string") {
          warnings.push(`Replacement for "${term}" in ${file} must be text; ignoring it.`);
          continue;
        }
        if (term.trim() === "") continue;
        setOwn(redaction.replacements, term, replacement);
      }
    }
  }
  return { redaction, warnings };
}

/** Writes `config/redaction.yaml`; throws only if the write fails. */
export function saveRedaction(paths, redaction) {
  const file = resolvePaths(paths).redactionYaml;
  const source = isPlainObject(redaction) ? redaction : {};
  const doc = {
    version: 1,
    always_redact: normaliseTerms(source.alwaysRedact, "always_redact", []),
    replacements: {},
  };
  const replacements = isPlainObject(source.replacements) ? source.replacements : {};
  for (const [term, replacement] of Object.entries(replacements)) {
    if (typeof replacement !== "string" || term.trim() === "") continue;
    setOwn(doc.replacements, term, replacement);
  }
  writeYamlFile(file, REDACTION_HEADER, doc, REDACTION_COMMENTS);
  return file;
}

/** The registry's tuning knobs, merged over `DEFAULT_SETTINGS`. */
export function settingsOf(registry) {
  const raw = isPlainObject(registry?.defaults) ? registry.defaults : {};
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = raw[key] ?? raw[JS_TO_YAML.get(key)];
    const parsed = toCount(value);
    if (parsed !== null) settings[key] = parsed;
  }
  return settings;
}

/** The git author names and emails that count as mine, trimmed and deduplicated. */
export function identitiesOf(registry) {
  return normaliseTerms(registry?.identities, "identities", []);
}

/** A unique registry key for a display name: `t3code`, then `t3code-2`, `t3code-3`, … */
export function projectKeyFor(displayName, takenKeys) {
  const taken = toKeySet(takenKeys);
  const base = slugify(displayName);
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** Shallow-merges `patch` into a project entry (creating it), unioning `roots`; returns the registry. */
export function upsertProject(registry, key, patch) {
  if (!isPlainObject(registry)) return registry;
  if (typeof key !== "string" || key === "") return registry;
  if (!isPlainObject(registry.projects)) registry.projects = {};

  let entry = Object.hasOwn(registry.projects, key) ? registry.projects[key] : undefined;
  if (!isPlainObject(entry)) {
    entry = { roots: [] };
    setOwn(registry.projects, key, entry);
  }
  if (!Array.isArray(entry.roots)) entry.roots = [];

  for (const [field, value] of Object.entries(isPlainObject(patch) ? patch : {})) {
    // `undefined` means "leave it alone"; use `null` to clear a field.
    if (value === undefined) continue;
    if (field === "roots") {
      entry.roots = unionRoots(entry.roots, value);
      continue;
    }
    setOwn(entry, field, value);
  }
  return registry;
}

/** The project key owning `absPath` — longest matching root wins — or null. */
export function matchProjectByRoot(registry, absPath) {
  const target = expandHome(absPath);
  if (target === "") return null;

  const projects = isPlainObject(registry?.projects) ? registry.projects : {};
  let bestKey = null;
  let bestLength = -1;
  for (const key of Object.keys(projects)) {
    const entry = projects[key];
    const roots = Array.isArray(entry?.roots) ? entry.roots : [];
    for (const root of roots) {
      const resolved = expandHome(root);
      // `isUnder` is true path-segment containment, so /a/bc never matches the root /a/b.
      if (resolved === "" || !isUnder(target, resolved)) continue;
      if (resolved.length > bestLength) {
        bestLength = resolved.length;
        bestKey = key;
      }
    }
  }
  return bestKey;
}

/** How a project may be talked about: `excluded`, `unconfirmed`, `public`, `generic` or `private`. */
export function classify(registry, key) {
  const projects = isPlainObject(registry?.projects) ? registry.projects : {};
  const raw = typeof key === "string" && Object.hasOwn(projects, key) ? projects[key] : undefined;
  if (!isPlainObject(raw)) {
    // An unknown project has never been reviewed by a human, so it is not describable at all.
    return {
      include: false,
      visibility: "private",
      confirmed: false,
      effective: "excluded",
      entry: null,
    };
  }

  const include = raw.include !== false;
  const confirmed = raw.confirmed === true;
  const visibility = VISIBILITIES.has(raw.visibility) ? raw.visibility : "generic";
  const effective = !include ? "excluded" : confirmed ? visibility : "unconfirmed";
  return { include, visibility, confirmed, effective, entry: raw };
}

/** True when the project may be named in a report. */
export function isNameable(classification) {
  return classification?.effective === "public";
}

/** True when the work may be described, named or not. */
export function isDescribable(classification) {
  return classification?.effective === "public" || classification?.effective === "generic";
}

/** True when the project's work belongs in the totals. */
export function isCountable(classification) {
  const effective = classification?.effective;
  return typeof effective === "string" && effective !== "excluded";
}

// --- internals --------------------------------------------------------------------------------

function emptyRegistry() {
  return { version: 1, identities: [], defaults: { ...DEFAULT_SETTINGS }, projects: {} };
}

// Callers pass the object from `worklogPaths()`, but a bare root string is an easy mistake to make
// and costs one line to support.
function resolvePaths(paths) {
  if (typeof paths === "string") return worklogPaths(paths);
  if (isPlainObject(paths) && typeof paths.projectsYaml === "string") return paths;
  if (isPlainObject(paths) && typeof paths.root === "string") return worklogPaths(paths.root);
  return worklogPaths();
}

function readYamlFile(file, label, warnings) {
  let text;
  try {
    text = NodeFS.readFileSync(file, "utf8");
  } catch (error) {
    warnings.push(
      error?.code === "ENOENT"
        ? `No ${label} at ${file} — run \`worklog init\` to create one.`
        : `Could not read the ${label} at ${file}: ${error?.message ?? String(error)}`,
    );
    return null;
  }
  try {
    const doc = parseYaml(text);
    if (!isPlainObject(doc)) {
      warnings.push(`The ${label} at ${file} is not a map; ignoring it.`);
      return null;
    }
    return doc;
  } catch (error) {
    const detail = error instanceof YamlLiteError ? error.message : String(error?.message ?? error);
    warnings.push(`Could not parse the ${label} at ${file}: ${detail} — ignoring the file.`);
    return null;
  }
}

// Rendered before anything is opened, and swapped in by rename: this file holds classification
// decisions a human made by hand, so a crash mid-write must not truncate it.
function writeYamlFile(file, header, doc, comments) {
  const text = `${header}${stringifyYaml(doc, { comments })}`;
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const staging = `${file}.tmp-${process.pid}`;
  try {
    NodeFS.writeFileSync(staging, text, "utf8");
    NodeFS.renameSync(staging, file);
  } catch (error) {
    NodeFS.rmSync(staging, { force: true });
    throw error;
  }
}

function normaliseRegistry(doc, warnings) {
  const registry = emptyRegistry();

  if (doc.version !== undefined && doc.version !== null) {
    if (typeof doc.version !== "number") {
      warnings.push(`"version" must be a number; assuming 1.`);
    } else {
      registry.version = doc.version;
      if (doc.version > 1) {
        warnings.push(`The registry says version ${doc.version}, but this build understands 1.`);
      }
    }
  }

  registry.identities = normaliseTerms(doc.identities, "identities", warnings);
  registry.defaults = normaliseDefaults(doc.defaults, warnings);
  registry.projects = normaliseProjects(doc.projects, warnings);
  Object.assign(registry, extraKeys(doc, ["version", "identities", "defaults", "projects"]));
  return registry;
}

function normaliseDefaults(value, warnings) {
  const defaults = { ...DEFAULT_SETTINGS };
  if (value === undefined || value === null) return defaults;
  if (!isPlainObject(value)) {
    warnings.push(`"defaults" must be a map; using the built-in defaults.`);
    return defaults;
  }
  const camel = toJsKeys(value);
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (camel[key] === undefined || camel[key] === null) continue;
    const parsed = toCount(camel[key]);
    if (parsed === null) {
      warnings.push(
        `defaults.${JS_TO_YAML.get(key) ?? key} must be a number of minutes; using ${DEFAULT_SETTINGS[key]}.`,
      );
      continue;
    }
    defaults[key] = parsed;
  }
  Object.assign(defaults, extraKeys(camel, Object.keys(DEFAULT_SETTINGS)));
  return defaults;
}

function normaliseProjects(value, warnings) {
  const projects = {};
  if (value === undefined || value === null) return projects;
  if (!isPlainObject(value)) {
    warnings.push(`"projects" must be a map of project key -> settings; ignoring it.`);
    return projects;
  }

  for (const key of Object.keys(value)) {
    const raw = value[key];
    if (key.trim() === "") {
      warnings.push("A project key cannot be empty; ignoring that entry.");
      continue;
    }
    if (!isPlainObject(raw)) {
      warnings.push(`Project "${key}" must be a map of settings; ignoring it.`);
      continue;
    }
    const entry = toJsKeys(raw);

    entry.roots = normaliseRoots(entry.roots, key, warnings);

    for (const field of ["displayName", "link", "blurb"]) {
      if (entry[field] === undefined || entry[field] === null) continue;
      if (typeof entry[field] !== "string") {
        warnings.push(
          `Project "${key}": ${JS_TO_YAML.get(field) ?? field} must be text; ignoring it.`,
        );
        delete entry[field];
      }
    }

    for (const field of ["include", "confirmed"]) {
      if (entry[field] === undefined || entry[field] === null) continue;
      if (typeof entry[field] !== "boolean") {
        // Fails closed: only the literal string "true" is generous enough to count as true.
        const coerced = entry[field] === "true";
        warnings.push(
          `Project "${key}": ${field} must be true or false; reading it as ${coerced}.`,
        );
        entry[field] = coerced;
      }
    }

    if (
      entry.visibility !== undefined &&
      entry.visibility !== null &&
      !VISIBILITIES.has(entry.visibility)
    ) {
      // Kept as written so a save does not silently rewrite the user's file; `classify` degrades it.
      warnings.push(
        `Project "${key}": visibility "${entry.visibility}" is not public/generic/private; treating it as generic.`,
      );
    }

    setOwn(projects, key, entry);
  }
  return projects;
}

function normaliseRoots(value, key, warnings) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`Project "${key}": roots must be a list of paths; ignoring it.`);
    return [];
  }
  const roots = [];
  for (const root of value) {
    if (typeof root !== "string" || root.trim() === "") {
      warnings.push(`Project "${key}": ignoring a root that is not a path.`);
      continue;
    }
    roots.push(root.trim());
  }
  return unionRoots([], roots);
}

// Roots are compared by their resolved form (so `~/Developer/x` and the absolute path are one
// root) but stored as written, which keeps a home-relative registry portable.
function unionRoots(existing, incoming) {
  const list = Array.isArray(incoming) ? incoming : [incoming];
  const out = [];
  const seen = new Set();
  for (const root of [...existing, ...list]) {
    if (typeof root !== "string" || root.trim() === "") continue;
    const resolved = expandHome(root);
    if (resolved === "" || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(root.trim());
  }
  return out;
}

function normaliseTerms(value, label, warnings) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`"${label}" must be a list; ignoring it.`);
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string") {
      warnings.push(`"${label}" contains a non-text entry; ignoring it.`);
      continue;
    }
    const trimmed = entry.trim();
    const fingerprint = trimmed.toLowerCase();
    if (trimmed === "" || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(trimmed);
  }
  return out;
}

function toJsKeys(obj) {
  return renameKeys(obj, YAML_TO_JS);
}

function toYamlKeys(obj) {
  return renameKeys(obj, JS_TO_YAML);
}

// Only the keys we know about are renamed; anything else passes through untouched, so a field a
// human added by hand survives a load/save cycle with its spelling intact.
function renameKeys(obj, map) {
  const out = {};
  if (!isPlainObject(obj)) return out;
  for (const key of Object.keys(obj)) {
    setOwn(out, map.get(key) ?? key, obj[key]);
  }
  return out;
}

function extraKeys(obj, known) {
  const out = {};
  if (!isPlainObject(obj)) return out;
  const skip = new Set(known);
  for (const key of Object.keys(obj)) {
    if (skip.has(key) || obj[key] === undefined) continue;
    setOwn(out, key, obj[key]);
  }
  return out;
}

function toCount(value) {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return n;
}

function toKeySet(takenKeys) {
  if (takenKeys instanceof Set) return takenKeys;
  if (Array.isArray(takenKeys)) return new Set(takenKeys.filter((key) => typeof key === "string"));
  if (isPlainObject(takenKeys)) return new Set(Object.keys(takenKeys));
  return new Set();
}

// A project key of `__proto__` would otherwise reach `Object.prototype` instead of the map.
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
