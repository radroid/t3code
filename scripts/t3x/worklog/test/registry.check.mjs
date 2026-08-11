import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import test from "node:test";

import { worklogPaths } from "../lib/paths.mjs";
import {
  classify,
  DEFAULT_SETTINGS,
  identitiesOf,
  isCountable,
  isDescribable,
  isNameable,
  loadRedaction,
  loadRegistry,
  matchProjectByRoot,
  projectKeyFor,
  saveRedaction,
  saveRegistry,
  settingsOf,
  upsertProject,
} from "../lib/registry.mjs";

/** A throwaway worklog repo; `t.after` removes it, so no test ever touches the real one. */
function tempPaths(t) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worklog-"));
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  return worklogPaths(root);
}

/** Writes `config/projects.yaml` verbatim inside a temp repo. */
function writeProjects(paths, text) {
  NodeFS.mkdirSync(paths.config, { recursive: true });
  NodeFS.writeFileSync(paths.projectsYaml, text, "utf8");
}

const SAMPLE_YAML = [
  "version: 1",
  "identities:",
  "  - Raj D",
  "  - raj@example.com",
  "defaults:",
  "  active_gap_minutes: 45",
  "  single_event_minutes: 2",
  "projects:",
  "  t3code:",
  "    display_name: T3 Code (fork)",
  "    roots:",
  "      - /tmp/dev/t3code",
  "      - /tmp/dev/t3code-work",
  "    include: true",
  "    visibility: public",
  "    confirmed: true",
  "    link: https://github.com/radroid/t3code",
  "    blurb: My fork of the T3 Code agent IDE",
  "  client-x:",
  "    display_name: Client X",
  "    roots:",
  "      - /tmp/dev/client-x",
  "    include: true",
  "    visibility: generic",
  "    confirmed: true",
  "  secret:",
  "    display_name: Secret Thing",
  "    roots: []",
  "    include: false",
  "    visibility: private",
  "    confirmed: true",
  "",
].join("\n");

test("a missing registry yields an empty registry and a warning, never a throw", (t) => {
  const paths = tempPaths(t);
  const { registry, warnings } = loadRegistry(paths);
  assert.deepEqual(registry, {
    version: 1,
    identities: [],
    defaults: { ...DEFAULT_SETTINGS },
    projects: {},
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /No project registry at/u);
  assert.match(warnings[0], /worklog init/u);
});

test("a malformed registry yields an empty registry and a warning naming the line", (t) => {
  const paths = tempPaths(t);
  writeProjects(paths, "version: 1\nprojects:\n\tt3code:\n");
  const { registry, warnings } = loadRegistry(paths);
  assert.deepEqual(registry.projects, {});
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /line 3/u);
  assert.match(warnings[0], /tabs are not allowed/u);
});

test("a registry that is not a map is ignored with a warning", (t) => {
  const paths = tempPaths(t);
  writeProjects(paths, "- one\n- two\n");
  const { registry, warnings } = loadRegistry(paths);
  assert.deepEqual(registry.projects, {});
  assert.equal(warnings.length, 1);
});

test("an unreadable registry warns instead of throwing", (t) => {
  const paths = tempPaths(t);
  // A directory where the file should be: readFileSync fails with EISDIR, not ENOENT.
  NodeFS.mkdirSync(paths.projectsYaml, { recursive: true });
  const { registry, warnings } = loadRegistry(paths);
  assert.deepEqual(registry.projects, {});
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not read the project registry/u);
});

test("snake_case on disk becomes camelCase in JS", (t) => {
  const paths = tempPaths(t);
  writeProjects(paths, SAMPLE_YAML);
  const { registry, warnings } = loadRegistry(paths);
  assert.deepEqual(warnings, []);
  assert.equal(registry.defaults.activeGapMinutes, 45);
  assert.equal(registry.defaults.singleEventMinutes, 2);
  assert.equal(registry.projects.t3code.displayName, "T3 Code (fork)");
  assert.equal(Object.hasOwn(registry.projects.t3code, "display_name"), false);
  assert.deepEqual(registry.identities, ["Raj D", "raj@example.com"]);
  assert.deepEqual(registry.projects.t3code.roots, ["/tmp/dev/t3code", "/tmp/dev/t3code-work"]);
});

test("save then load is lossless", (t) => {
  const paths = tempPaths(t);
  writeProjects(paths, SAMPLE_YAML);
  const first = loadRegistry(paths).registry;

  saveRegistry(paths, first);
  const second = loadRegistry(paths);
  assert.deepEqual(second.warnings, []);
  assert.deepEqual(second.registry, first);

  // And it is a fixed point: saving what we just loaded produces byte-identical text.
  const textA = NodeFS.readFileSync(paths.projectsYaml, "utf8");
  saveRegistry(paths, second.registry);
  assert.equal(NodeFS.readFileSync(paths.projectsYaml, "utf8"), textA);
});

test("an empty registry round-trips, and the saved file explains itself", (t) => {
  const paths = tempPaths(t);
  const empty = loadRegistry(paths).registry;
  saveRegistry(paths, empty);

  const text = NodeFS.readFileSync(paths.projectsYaml, "utf8");
  assert.match(text, /^# \/worklog project registry/u);
  assert.match(text, /visibility: public/u);
  assert.match(text, /\nidentities: \[\]\n/u);
  assert.match(text, /\nprojects: \{\}\n/u);
  assert.deepEqual(loadRegistry(paths).registry, empty);
});

test("save creates the config directory when the repo is bare", (t) => {
  const paths = tempPaths(t);
  assert.equal(NodeFS.existsSync(paths.config), false);
  saveRegistry(paths, { projects: { a: { displayName: "A", roots: ["/tmp/a"] } } });
  assert.equal(NodeFS.existsSync(paths.projectsYaml), true);
  assert.equal(loadRegistry(paths).registry.projects.a.displayName, "A");
});

test("a save that cannot be written fails loudly and leaves no debris", (t) => {
  const paths = tempPaths(t);
  // A directory where the file belongs: the rename cannot succeed.
  NodeFS.mkdirSync(paths.projectsYaml, { recursive: true });
  assert.throws(() => saveRegistry(paths, { projects: { a: { displayName: "A" } } }));
  assert.deepEqual(NodeFS.readdirSync(paths.config), ["projects.yaml"]);
});

test("a bare root string is accepted in place of a paths object", (t) => {
  const paths = tempPaths(t);
  saveRegistry(paths.root, { projects: { a: { displayName: "A" } } });
  assert.equal(loadRegistry(paths.root).registry.projects.a.displayName, "A");
});

test("unknown fields survive a load/save cycle", (t) => {
  const paths = tempPaths(t);
  writeProjects(
    paths,
    [
      "version: 1",
      "note: hand written",
      "projects:",
      "  a:",
      "    display_name: A",
      "    owner: raj",
      "",
    ].join("\n"),
  );
  const { registry } = loadRegistry(paths);
  assert.equal(registry.note, "hand written");
  assert.equal(registry.projects.a.owner, "raj");

  saveRegistry(paths, registry);
  const text = NodeFS.readFileSync(paths.projectsYaml, "utf8");
  assert.match(text, /note: hand written/u);
  assert.match(text, /owner: raj/u);
  assert.deepEqual(loadRegistry(paths).registry, registry);
});

test("bad field shapes warn and fall back instead of throwing", (t) => {
  const paths = tempPaths(t);
  writeProjects(
    paths,
    [
      "version: two",
      "identities: nope",
      "defaults:",
      "  active_gap_minutes: soon",
      "projects:",
      "  a:",
      "    display_name: 12",
      "    roots: /tmp/a",
      "    include: yes",
      "    visibility: semi-public",
      "  b: 7",
      "",
    ].join("\n"),
  );
  const { registry, warnings } = loadRegistry(paths);

  assert.equal(registry.version, 1);
  assert.deepEqual(registry.identities, []);
  assert.deepEqual(registry.defaults, { ...DEFAULT_SETTINGS });
  assert.equal(Object.hasOwn(registry.projects, "b"), false);
  assert.equal(Object.hasOwn(registry.projects.a, "displayName"), false);
  assert.deepEqual(registry.projects.a.roots, []);
  // "yes" is not "true", so include fails closed.
  assert.equal(registry.projects.a.include, false);
  assert.equal(classify(registry, "a").effective, "excluded");
  assert.ok(warnings.length >= 6, `expected a warning per problem, got ${warnings.length}`);
});

test("identities and roots are trimmed and deduplicated", (t) => {
  const paths = tempPaths(t);
  writeProjects(
    paths,
    [
      "identities:",
      '  - "  Raj D  "',
      "  - raj d",
      "  - raj@example.com",
      '  - ""',
      "projects:",
      "  a:",
      "    roots:",
      "      - /tmp/a",
      "      - /tmp/a/",
      "      - /tmp/b",
      "",
    ].join("\n"),
  );
  const { registry } = loadRegistry(paths);
  assert.deepEqual(registry.identities, ["Raj D", "raj@example.com"]);
  assert.deepEqual(registry.projects.a.roots, ["/tmp/a", "/tmp/b"]);
  assert.deepEqual(identitiesOf(registry), ["Raj D", "raj@example.com"]);
});

test("settingsOf merges over the defaults and rejects nonsense", () => {
  assert.deepEqual(settingsOf(null), { ...DEFAULT_SETTINGS });
  assert.deepEqual(settingsOf({}), { ...DEFAULT_SETTINGS });
  assert.deepEqual(settingsOf({ defaults: { activeGapMinutes: 15 } }), {
    activeGapMinutes: 15,
    singleEventMinutes: DEFAULT_SETTINGS.singleEventMinutes,
  });
  assert.deepEqual(settingsOf({ defaults: { singleEventMinutes: 0 } }), {
    activeGapMinutes: DEFAULT_SETTINGS.activeGapMinutes,
    singleEventMinutes: 0,
  });
  // Snake_case is tolerated in case a raw document reaches this function.
  assert.equal(settingsOf({ defaults: { active_gap_minutes: 20 } }).activeGapMinutes, 20);
  assert.deepEqual(settingsOf({ defaults: { activeGapMinutes: -5 } }), { ...DEFAULT_SETTINGS });
  assert.deepEqual(settingsOf({ defaults: { activeGapMinutes: "abc" } }), { ...DEFAULT_SETTINGS });
  assert.deepEqual(settingsOf({ defaults: "nope" }), { ...DEFAULT_SETTINGS });
});

test("identitiesOf survives a junk registry", () => {
  assert.deepEqual(identitiesOf(undefined), []);
  assert.deepEqual(identitiesOf({ identities: "one" }), []);
  assert.deepEqual(identitiesOf({ identities: ["a", 7, null, "a"] }), ["a"]);
});

test("projectKeyFor slugifies and disambiguates", () => {
  assert.equal(projectKeyFor("T3 Code (fork)", []), "t3-code-fork");
  assert.equal(projectKeyFor("t3code", ["t3code"]), "t3code-2");
  assert.equal(projectKeyFor("t3code", ["t3code", "t3code-2"]), "t3code-3");
  assert.equal(projectKeyFor("t3code", new Set(["t3code"])), "t3code-2");
  // A registry's projects map is a natural argument.
  assert.equal(projectKeyFor("t3code", { t3code: {}, "t3code-2": {} }), "t3code-3");
  assert.equal(projectKeyFor("Café Ops", []), "cafe-ops");
  assert.equal(projectKeyFor("", []), "unknown");
  assert.equal(projectKeyFor("!!!", ["unknown"]), "unknown-2");
});

test("upsertProject creates, shallow-merges, and unions roots", () => {
  const registry = { projects: {} };

  upsertProject(registry, "t3code", { displayName: "T3 Code", roots: ["/tmp/a"] });
  assert.deepEqual(registry.projects.t3code, { roots: ["/tmp/a"], displayName: "T3 Code" });

  upsertProject(registry, "t3code", { roots: ["/tmp/b", "/tmp/a"], visibility: "public" });
  assert.deepEqual(registry.projects.t3code.roots, ["/tmp/a", "/tmp/b"]);
  assert.equal(registry.projects.t3code.visibility, "public");
  assert.equal(registry.projects.t3code.displayName, "T3 Code");

  // Undefined leaves a field alone; null clears it.
  upsertProject(registry, "t3code", { displayName: undefined, blurb: null });
  assert.equal(registry.projects.t3code.displayName, "T3 Code");
  assert.equal(registry.projects.t3code.blurb, null);

  // Roots are deduplicated by their resolved form, keeping the first spelling.
  upsertProject(registry, "t3code", { roots: ["/tmp/a/", "/tmp/./b"] });
  assert.deepEqual(registry.projects.t3code.roots, ["/tmp/a", "/tmp/b"]);

  assert.equal(upsertProject(registry, "t3code", {}), registry);
  assert.equal(upsertProject(registry, "", { displayName: "X" }), registry);
  assert.deepEqual(Object.keys(registry.projects), ["t3code"]);
});

test("upsertProject builds a projects map when the registry has none", () => {
  const registry = {};
  upsertProject(registry, "a", { roots: "/tmp/a" });
  assert.deepEqual(registry.projects.a.roots, ["/tmp/a"]);
});

test("a __proto__ project key cannot reach Object.prototype", (t) => {
  const paths = tempPaths(t);
  const registry = { projects: {} };
  upsertProject(registry, "__proto__", { displayName: "nope" });
  assert.equal({}.displayName, undefined);
  assert.equal(registry.projects.__proto__.displayName, "nope");
  assert.equal(classify(registry, "__proto__").effective, "unconfirmed");

  saveRegistry(paths, registry);
  const reloaded = loadRegistry(paths).registry;
  assert.equal(reloaded.projects.__proto__.displayName, "nope");
  assert.equal({}.displayName, undefined);
});

test("classify: an unknown project fails closed", () => {
  const registry = { projects: { a: { confirmed: true, visibility: "public" } } };
  for (const key of ["missing", "", null, undefined, "__proto__", "toString"]) {
    const classification = classify(registry, key);
    assert.equal(classification.effective, "excluded", `key ${String(key)}`);
    assert.equal(classification.entry, null);
    assert.equal(classification.include, false);
    assert.equal(isNameable(classification), false);
    assert.equal(isDescribable(classification), false);
    assert.equal(isCountable(classification), false);
  }
  assert.equal(classify(null, "a").effective, "excluded");
  assert.equal(classify({ projects: "nope" }, "a").effective, "excluded");
});

test("classify: the visibility matrix", () => {
  const registry = {
    projects: {
      pub: { visibility: "public", confirmed: true },
      gen: { visibility: "generic", confirmed: true },
      priv: { visibility: "private", confirmed: true },
      unconfirmed: { visibility: "public" },
      excluded: { visibility: "public", confirmed: true, include: false },
      weird: { visibility: "semi-public", confirmed: true },
      bare: { confirmed: true },
    },
  };
  const effective = (key) => classify(registry, key).effective;

  assert.equal(effective("pub"), "public");
  assert.equal(effective("gen"), "generic");
  assert.equal(effective("priv"), "private");
  assert.equal(effective("unconfirmed"), "unconfirmed");
  assert.equal(effective("excluded"), "excluded");
  // An unrecognised visibility degrades to generic; a missing one defaults to it.
  assert.equal(effective("weird"), "generic");
  assert.equal(classify(registry, "weird").visibility, "generic");
  assert.equal(effective("bare"), "generic");
  // `include` defaults to true, and the raw entry comes back for the caller.
  assert.equal(classify(registry, "pub").include, true);
  assert.equal(classify(registry, "pub").entry, registry.projects.pub);

  const expected = {
    pub: [true, true, true],
    gen: [false, true, true],
    priv: [false, false, true],
    unconfirmed: [false, false, true],
    excluded: [false, false, false],
  };
  for (const [key, [nameable, describable, countable]] of Object.entries(expected)) {
    const classification = classify(registry, key);
    assert.equal(isNameable(classification), nameable, `${key} nameable`);
    assert.equal(isDescribable(classification), describable, `${key} describable`);
    assert.equal(isCountable(classification), countable, `${key} countable`);
  }
});

test("the visibility predicates are null-safe", () => {
  for (const junk of [null, undefined, {}, { effective: "nonsense" }]) {
    assert.equal(isNameable(junk), false);
    assert.equal(isDescribable(junk), false);
  }
  assert.equal(isCountable(null), false);
  assert.equal(isCountable({}), false);
  assert.equal(isCountable({ effective: "nonsense" }), true);
});

test("matchProjectByRoot: longest root wins and containment is by segment", () => {
  const registry = {
    projects: {
      outer: { roots: ["/tmp/dev"] },
      inner: { roots: ["/tmp/dev/t3code"] },
      sibling: { roots: ["/tmp/development"] },
      empty: { roots: [] },
      broken: { roots: "not a list" },
    },
  };

  assert.equal(matchProjectByRoot(registry, "/tmp/dev/t3code/apps/server/index.ts"), "inner");
  assert.equal(matchProjectByRoot(registry, "/tmp/dev/t3code"), "inner");
  assert.equal(matchProjectByRoot(registry, "/tmp/dev/other"), "outer");
  // /tmp/dev/t3code-work is a sibling of the root, not a child of it.
  assert.equal(matchProjectByRoot(registry, "/tmp/dev/t3code-work"), "outer");
  assert.equal(matchProjectByRoot(registry, "/tmp/development/x"), "sibling");
  assert.equal(matchProjectByRoot(registry, "/tmp/elsewhere"), null);
  assert.equal(matchProjectByRoot(registry, ""), null);
  assert.equal(matchProjectByRoot(registry, null), null);
  assert.equal(matchProjectByRoot(null, "/tmp/dev"), null);
});

test("matchProjectByRoot expands ~ on both sides", (t) => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worklog-home-"));
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = previous;
    NodeFS.rmSync(home, { recursive: true, force: true });
  });

  const registry = { projects: { a: { roots: ["~/Developer/a"] } } };
  assert.equal(matchProjectByRoot(registry, NodePath.join(home, "Developer/a/src/index.ts")), "a");
  assert.equal(matchProjectByRoot(registry, "~/Developer/a"), "a");
  assert.equal(matchProjectByRoot(registry, "~/Developer/b"), null);
});

test("redaction: missing, malformed and valid files", (t) => {
  const paths = tempPaths(t);

  const missing = loadRedaction(paths);
  assert.deepEqual(missing.redaction, { alwaysRedact: [], replacements: {} });
  assert.equal(missing.warnings.length, 1);

  NodeFS.mkdirSync(paths.config, { recursive: true });
  NodeFS.writeFileSync(paths.redactionYaml, "always_redact:\n  - [oops]\n", "utf8");
  const broken = loadRedaction(paths);
  assert.deepEqual(broken.redaction, { alwaysRedact: [], replacements: {} });
  assert.match(broken.warnings[0], /line 2/u);

  NodeFS.writeFileSync(
    paths.redactionYaml,
    [
      "version: 1",
      "always_redact:",
      "  - Some Client Name",
      "  - some client name",
      "  - 7",
      "replacements:",
      '  "Some Client Name": a client',
      "  Other: 9",
      "",
    ].join("\n"),
    "utf8",
  );
  const { redaction, warnings } = loadRedaction(paths);
  assert.deepEqual(redaction.alwaysRedact, ["Some Client Name"]);
  assert.deepEqual(redaction.replacements, { "Some Client Name": "a client" });
  assert.equal(warnings.length, 2);
});

test("redaction: save then load is lossless", (t) => {
  const paths = tempPaths(t);
  const redaction = {
    alwaysRedact: ["Acme Corp", "Project Nimbus"],
    replacements: { "Acme Corp": "a client", "Project Nimbus": "an internal project" },
  };
  saveRedaction(paths, redaction);

  const text = NodeFS.readFileSync(paths.redactionYaml, "utf8");
  assert.match(text, /^# \/worklog redaction list/u);
  assert.match(text, /version: 1/u);

  const loaded = loadRedaction(paths);
  assert.deepEqual(loaded.warnings, []);
  assert.deepEqual(loaded.redaction, redaction);

  // Empty is a legal state too.
  saveRedaction(paths, {});
  assert.deepEqual(loadRedaction(paths).redaction, { alwaysRedact: [], replacements: {} });
});

test("no public function throws on junk input", (t) => {
  const paths = tempPaths(t);
  for (const junk of [null, undefined, 42, "string", [], { projects: [] }]) {
    assert.doesNotThrow(() => settingsOf(junk));
    assert.doesNotThrow(() => identitiesOf(junk));
    assert.doesNotThrow(() => classify(junk, "a"));
    assert.doesNotThrow(() => matchProjectByRoot(junk, "/tmp/a"));
    assert.doesNotThrow(() => upsertProject(junk, "a", { roots: junk }));
    assert.doesNotThrow(() => projectKeyFor(junk, junk));
    assert.doesNotThrow(() => saveRegistry(paths, junk));
    assert.doesNotThrow(() => saveRedaction(paths, junk));
    assert.doesNotThrow(() => loadRegistry(paths));
    assert.doesNotThrow(() => loadRedaction(paths));
  }
});
