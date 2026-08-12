import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

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

NodeTest.test("a missing registry yields an empty registry and a warning, never a throw", (t) => {
  const paths = tempPaths(t);
  const { registry, warnings } = loadRegistry(paths);
  NodeAssert.deepEqual(registry, {
    version: 1,
    identities: [],
    defaults: { ...DEFAULT_SETTINGS },
    projects: {},
  });
  NodeAssert.equal(warnings.length, 1);
  NodeAssert.match(warnings[0], /No project registry at/u);
  NodeAssert.match(warnings[0], /worklog init/u);
});

NodeTest.test(
  "a malformed registry yields an empty registry and a warning naming the line",
  (t) => {
    const paths = tempPaths(t);
    writeProjects(paths, "version: 1\nprojects:\n\tt3code:\n");
    const { registry, warnings } = loadRegistry(paths);
    NodeAssert.deepEqual(registry.projects, {});
    NodeAssert.equal(warnings.length, 1);
    NodeAssert.match(warnings[0], /line 3/u);
    NodeAssert.match(warnings[0], /tabs are not allowed/u);
  },
);

NodeTest.test("a registry that is not a map is ignored with a warning", (t) => {
  const paths = tempPaths(t);
  writeProjects(paths, "- one\n- two\n");
  const { registry, warnings } = loadRegistry(paths);
  NodeAssert.deepEqual(registry.projects, {});
  NodeAssert.equal(warnings.length, 1);
});

NodeTest.test("an unreadable registry warns instead of throwing", (t) => {
  const paths = tempPaths(t);
  // A directory where the file should be: readFileSync fails with EISDIR, not ENOENT.
  NodeFS.mkdirSync(paths.projectsYaml, { recursive: true });
  const { registry, warnings } = loadRegistry(paths);
  NodeAssert.deepEqual(registry.projects, {});
  NodeAssert.equal(warnings.length, 1);
  NodeAssert.match(warnings[0], /Could not read the project registry/u);
});

NodeTest.test("snake_case on disk becomes camelCase in JS", (t) => {
  const paths = tempPaths(t);
  writeProjects(paths, SAMPLE_YAML);
  const { registry, warnings } = loadRegistry(paths);
  NodeAssert.deepEqual(warnings, []);
  NodeAssert.equal(registry.defaults.activeGapMinutes, 45);
  NodeAssert.equal(registry.defaults.singleEventMinutes, 2);
  NodeAssert.equal(registry.projects.t3code.displayName, "T3 Code (fork)");
  NodeAssert.equal(Object.hasOwn(registry.projects.t3code, "display_name"), false);
  NodeAssert.deepEqual(registry.identities, ["Raj D", "raj@example.com"]);
  NodeAssert.deepEqual(registry.projects.t3code.roots, ["/tmp/dev/t3code", "/tmp/dev/t3code-work"]);
});

NodeTest.test("save then load is lossless", (t) => {
  const paths = tempPaths(t);
  writeProjects(paths, SAMPLE_YAML);
  const first = loadRegistry(paths).registry;

  saveRegistry(paths, first);
  const second = loadRegistry(paths);
  NodeAssert.deepEqual(second.warnings, []);
  NodeAssert.deepEqual(second.registry, first);

  // And it is a fixed point: saving what we just loaded produces byte-identical text.
  const textA = NodeFS.readFileSync(paths.projectsYaml, "utf8");
  saveRegistry(paths, second.registry);
  NodeAssert.equal(NodeFS.readFileSync(paths.projectsYaml, "utf8"), textA);
});

NodeTest.test("an empty registry round-trips, and the saved file explains itself", (t) => {
  const paths = tempPaths(t);
  const empty = loadRegistry(paths).registry;
  saveRegistry(paths, empty);

  const text = NodeFS.readFileSync(paths.projectsYaml, "utf8");
  NodeAssert.match(text, /^# \/worklog project registry/u);
  NodeAssert.match(text, /visibility: public/u);
  NodeAssert.match(text, /\nidentities: \[\]\n/u);
  NodeAssert.match(text, /\nprojects: \{\}\n/u);
  NodeAssert.deepEqual(loadRegistry(paths).registry, empty);
});

NodeTest.test("a save that would erase every classification is refused", (t) => {
  const paths = tempPaths(t);
  writeProjects(paths, SAMPLE_YAML);
  const before = NodeFS.readFileSync(paths.projectsYaml, "utf8");

  // The shape that costs a human their work: a reader degraded an unreadable file to an empty
  // registry, and something wrote that back. One unreadable byte must not erase the answers.
  NodeAssert.throws(
    () => saveRegistry(paths, { version: 1, identities: [], projects: {} }),
    /Refusing to overwrite/u,
  );
  NodeAssert.equal(
    NodeFS.readFileSync(paths.projectsYaml, "utf8"),
    before,
    "the file is untouched",
  );

  // Identities alone are worth protecting: they decide whose commits count.
  const identitiesOnly = tempPaths(t);
  writeProjects(identitiesOnly, "version: 1\nidentities:\n  - Raj D\nprojects: {}\n");
  NodeAssert.throws(() => saveRegistry(identitiesOnly, {}), /Refusing to overwrite/u);

  // The narrowness matters as much as the rule. Emptying what was already empty is a no-op, and
  // an unparseable file holds no decision anybody can read back.
  const wasEmpty = tempPaths(t);
  writeProjects(wasEmpty, "version: 1\nidentities: []\nprojects: {}\n");
  NodeAssert.doesNotThrow(() => saveRegistry(wasEmpty, {}));

  const junk = tempPaths(t);
  writeProjects(junk, "projects: [not, a, map\n");
  NodeAssert.doesNotThrow(() => saveRegistry(junk, {}));

  // And a registry that still names something is written as normal.
  const kept = tempPaths(t);
  writeProjects(kept, SAMPLE_YAML);
  NodeAssert.doesNotThrow(() =>
    saveRegistry(kept, { projects: { a: { displayName: "A", roots: ["/tmp/a"] } } }),
  );
  NodeAssert.equal(loadRegistry(kept).registry.projects.a.displayName, "A");
});

NodeTest.test("save creates the config directory when the repo is bare", (t) => {
  const paths = tempPaths(t);
  NodeAssert.equal(NodeFS.existsSync(paths.config), false);
  saveRegistry(paths, { projects: { a: { displayName: "A", roots: ["/tmp/a"] } } });
  NodeAssert.equal(NodeFS.existsSync(paths.projectsYaml), true);
  NodeAssert.equal(loadRegistry(paths).registry.projects.a.displayName, "A");
});

NodeTest.test("a save that cannot be written fails loudly and leaves no debris", (t) => {
  const paths = tempPaths(t);
  // A directory where the file belongs: the rename cannot succeed.
  NodeFS.mkdirSync(paths.projectsYaml, { recursive: true });
  NodeAssert.throws(() => saveRegistry(paths, { projects: { a: { displayName: "A" } } }));
  NodeAssert.deepEqual(NodeFS.readdirSync(paths.config), ["projects.yaml"]);
});

NodeTest.test("a bare root string is accepted in place of a paths object", (t) => {
  const paths = tempPaths(t);
  saveRegistry(paths.root, { projects: { a: { displayName: "A" } } });
  NodeAssert.equal(loadRegistry(paths.root).registry.projects.a.displayName, "A");
});

NodeTest.test("unknown fields survive a load/save cycle", (t) => {
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
  NodeAssert.equal(registry.note, "hand written");
  NodeAssert.equal(registry.projects.a.owner, "raj");

  saveRegistry(paths, registry);
  const text = NodeFS.readFileSync(paths.projectsYaml, "utf8");
  NodeAssert.match(text, /note: hand written/u);
  NodeAssert.match(text, /owner: raj/u);
  NodeAssert.deepEqual(loadRegistry(paths).registry, registry);
});

NodeTest.test("bad field shapes warn and fall back instead of throwing", (t) => {
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

  NodeAssert.equal(registry.version, 1);
  NodeAssert.deepEqual(registry.identities, []);
  NodeAssert.deepEqual(registry.defaults, { ...DEFAULT_SETTINGS });
  NodeAssert.equal(Object.hasOwn(registry.projects, "b"), false);
  NodeAssert.equal(Object.hasOwn(registry.projects.a, "displayName"), false);
  NodeAssert.deepEqual(registry.projects.a.roots, []);
  // "yes" is not "true", so include fails closed.
  NodeAssert.equal(registry.projects.a.include, false);
  NodeAssert.equal(classify(registry, "a").effective, "excluded");
  NodeAssert.ok(warnings.length >= 6, `expected a warning per problem, got ${warnings.length}`);
});

NodeTest.test("identities and roots are trimmed and deduplicated", (t) => {
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
  NodeAssert.deepEqual(registry.identities, ["Raj D", "raj@example.com"]);
  NodeAssert.deepEqual(registry.projects.a.roots, ["/tmp/a", "/tmp/b"]);
  NodeAssert.deepEqual(identitiesOf(registry), ["Raj D", "raj@example.com"]);
});

NodeTest.test("settingsOf merges over the defaults and rejects nonsense", () => {
  NodeAssert.deepEqual(settingsOf(null), { ...DEFAULT_SETTINGS });
  NodeAssert.deepEqual(settingsOf({}), { ...DEFAULT_SETTINGS });
  NodeAssert.deepEqual(settingsOf({ defaults: { activeGapMinutes: 15 } }), {
    activeGapMinutes: 15,
    singleEventMinutes: DEFAULT_SETTINGS.singleEventMinutes,
  });
  NodeAssert.deepEqual(settingsOf({ defaults: { singleEventMinutes: 0 } }), {
    activeGapMinutes: DEFAULT_SETTINGS.activeGapMinutes,
    singleEventMinutes: 0,
  });
  // Snake_case is tolerated in case a raw document reaches this function.
  NodeAssert.equal(settingsOf({ defaults: { active_gap_minutes: 20 } }).activeGapMinutes, 20);
  NodeAssert.deepEqual(settingsOf({ defaults: { activeGapMinutes: -5 } }), { ...DEFAULT_SETTINGS });
  NodeAssert.deepEqual(settingsOf({ defaults: { activeGapMinutes: "abc" } }), {
    ...DEFAULT_SETTINGS,
  });
  NodeAssert.deepEqual(settingsOf({ defaults: "nope" }), { ...DEFAULT_SETTINGS });
});

NodeTest.test("identitiesOf survives a junk registry", () => {
  NodeAssert.deepEqual(identitiesOf(undefined), []);
  NodeAssert.deepEqual(identitiesOf({ identities: "one" }), []);
  NodeAssert.deepEqual(identitiesOf({ identities: ["a", 7, null, "a"] }), ["a"]);
});

NodeTest.test("projectKeyFor slugifies and disambiguates", () => {
  NodeAssert.equal(projectKeyFor("T3 Code (fork)", []), "t3-code-fork");
  NodeAssert.equal(projectKeyFor("t3code", ["t3code"]), "t3code-2");
  NodeAssert.equal(projectKeyFor("t3code", ["t3code", "t3code-2"]), "t3code-3");
  NodeAssert.equal(projectKeyFor("t3code", new Set(["t3code"])), "t3code-2");
  // A registry's projects map is a natural argument.
  NodeAssert.equal(projectKeyFor("t3code", { t3code: {}, "t3code-2": {} }), "t3code-3");
  NodeAssert.equal(projectKeyFor("Café Ops", []), "cafe-ops");
  NodeAssert.equal(projectKeyFor("", []), "unknown");
  NodeAssert.equal(projectKeyFor("!!!", ["unknown"]), "unknown-2");
});

NodeTest.test("upsertProject creates, shallow-merges, and unions roots", () => {
  const registry = { projects: {} };

  upsertProject(registry, "t3code", { displayName: "T3 Code", roots: ["/tmp/a"] });
  NodeAssert.deepEqual(registry.projects.t3code, { roots: ["/tmp/a"], displayName: "T3 Code" });

  upsertProject(registry, "t3code", { roots: ["/tmp/b", "/tmp/a"], visibility: "public" });
  NodeAssert.deepEqual(registry.projects.t3code.roots, ["/tmp/a", "/tmp/b"]);
  NodeAssert.equal(registry.projects.t3code.visibility, "public");
  NodeAssert.equal(registry.projects.t3code.displayName, "T3 Code");

  // Undefined leaves a field alone; null clears it.
  upsertProject(registry, "t3code", { displayName: undefined, blurb: null });
  NodeAssert.equal(registry.projects.t3code.displayName, "T3 Code");
  NodeAssert.equal(registry.projects.t3code.blurb, null);

  // Roots are deduplicated by their resolved form, keeping the first spelling.
  upsertProject(registry, "t3code", { roots: ["/tmp/a/", "/tmp/./b"] });
  NodeAssert.deepEqual(registry.projects.t3code.roots, ["/tmp/a", "/tmp/b"]);

  NodeAssert.equal(upsertProject(registry, "t3code", {}), registry);
  NodeAssert.equal(upsertProject(registry, "", { displayName: "X" }), registry);
  NodeAssert.deepEqual(Object.keys(registry.projects), ["t3code"]);
});

NodeTest.test("upsertProject builds a projects map when the registry has none", () => {
  const registry = {};
  upsertProject(registry, "a", { roots: "/tmp/a" });
  NodeAssert.deepEqual(registry.projects.a.roots, ["/tmp/a"]);
});

NodeTest.test("a __proto__ project key cannot reach Object.prototype", (t) => {
  const paths = tempPaths(t);
  const registry = { projects: {} };
  upsertProject(registry, "__proto__", { displayName: "nope" });
  NodeAssert.equal({}.displayName, undefined);
  NodeAssert.equal(registry.projects.__proto__.displayName, "nope");
  NodeAssert.equal(classify(registry, "__proto__").effective, "unconfirmed");

  saveRegistry(paths, registry);
  const reloaded = loadRegistry(paths).registry;
  NodeAssert.equal(reloaded.projects.__proto__.displayName, "nope");
  NodeAssert.equal({}.displayName, undefined);
});

NodeTest.test("classify: an unknown project fails closed", () => {
  const registry = { projects: { a: { confirmed: true, visibility: "public" } } };
  for (const key of ["missing", "", null, undefined, "__proto__", "toString"]) {
    const classification = classify(registry, key);
    NodeAssert.equal(classification.effective, "excluded", `key ${String(key)}`);
    NodeAssert.equal(classification.entry, null);
    NodeAssert.equal(classification.include, false);
    NodeAssert.equal(isNameable(classification), false);
    NodeAssert.equal(isDescribable(classification), false);
    NodeAssert.equal(isCountable(classification), false);
  }
  NodeAssert.equal(classify(null, "a").effective, "excluded");
  NodeAssert.equal(classify({ projects: "nope" }, "a").effective, "excluded");
});

NodeTest.test("classify: the visibility matrix", () => {
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

  NodeAssert.equal(effective("pub"), "public");
  NodeAssert.equal(effective("gen"), "generic");
  NodeAssert.equal(effective("priv"), "private");
  NodeAssert.equal(effective("unconfirmed"), "unconfirmed");
  NodeAssert.equal(effective("excluded"), "excluded");
  // An unrecognised visibility degrades to generic; a missing one defaults to it.
  NodeAssert.equal(effective("weird"), "generic");
  NodeAssert.equal(classify(registry, "weird").visibility, "generic");
  NodeAssert.equal(effective("bare"), "generic");
  // `include` defaults to true, and the raw entry comes back for the caller.
  NodeAssert.equal(classify(registry, "pub").include, true);
  NodeAssert.equal(classify(registry, "pub").entry, registry.projects.pub);

  const expected = {
    pub: [true, true, true],
    gen: [false, true, true],
    priv: [false, false, true],
    unconfirmed: [false, false, true],
    excluded: [false, false, false],
  };
  for (const [key, [nameable, describable, countable]] of Object.entries(expected)) {
    const classification = classify(registry, key);
    NodeAssert.equal(isNameable(classification), nameable, `${key} nameable`);
    NodeAssert.equal(isDescribable(classification), describable, `${key} describable`);
    NodeAssert.equal(isCountable(classification), countable, `${key} countable`);
  }
});

NodeTest.test("the visibility predicates are null-safe", () => {
  for (const junk of [null, undefined, {}, { effective: "nonsense" }]) {
    NodeAssert.equal(isNameable(junk), false);
    NodeAssert.equal(isDescribable(junk), false);
  }
  NodeAssert.equal(isCountable(null), false);
  NodeAssert.equal(isCountable({}), false);
  NodeAssert.equal(isCountable({ effective: "nonsense" }), true);
});

NodeTest.test("matchProjectByRoot: longest root wins and containment is by segment", () => {
  const registry = {
    projects: {
      outer: { roots: ["/tmp/dev"] },
      inner: { roots: ["/tmp/dev/t3code"] },
      sibling: { roots: ["/tmp/development"] },
      empty: { roots: [] },
      broken: { roots: "not a list" },
    },
  };

  NodeAssert.equal(matchProjectByRoot(registry, "/tmp/dev/t3code/apps/server/index.ts"), "inner");
  NodeAssert.equal(matchProjectByRoot(registry, "/tmp/dev/t3code"), "inner");
  NodeAssert.equal(matchProjectByRoot(registry, "/tmp/dev/other"), "outer");
  // /tmp/dev/t3code-work is a sibling of the root, not a child of it.
  NodeAssert.equal(matchProjectByRoot(registry, "/tmp/dev/t3code-work"), "outer");
  NodeAssert.equal(matchProjectByRoot(registry, "/tmp/development/x"), "sibling");
  NodeAssert.equal(matchProjectByRoot(registry, "/tmp/elsewhere"), null);
  NodeAssert.equal(matchProjectByRoot(registry, ""), null);
  NodeAssert.equal(matchProjectByRoot(registry, null), null);
  NodeAssert.equal(matchProjectByRoot(null, "/tmp/dev"), null);
});

NodeTest.test("matchProjectByRoot expands ~ on both sides", (t) => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worklog-home-"));
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = previous;
    NodeFS.rmSync(home, { recursive: true, force: true });
  });

  const registry = { projects: { a: { roots: ["~/Developer/a"] } } };
  NodeAssert.equal(
    matchProjectByRoot(registry, NodePath.join(home, "Developer/a/src/index.ts")),
    "a",
  );
  NodeAssert.equal(matchProjectByRoot(registry, "~/Developer/a"), "a");
  NodeAssert.equal(matchProjectByRoot(registry, "~/Developer/b"), null);
});

NodeTest.test("redaction: missing, malformed and valid files", (t) => {
  const paths = tempPaths(t);

  const missing = loadRedaction(paths);
  NodeAssert.deepEqual(missing.redaction, { alwaysRedact: [], replacements: {} });
  NodeAssert.equal(missing.warnings.length, 1);

  NodeFS.mkdirSync(paths.config, { recursive: true });
  NodeFS.writeFileSync(paths.redactionYaml, "always_redact:\n  - [oops]\n", "utf8");
  const broken = loadRedaction(paths);
  NodeAssert.deepEqual(broken.redaction, { alwaysRedact: [], replacements: {} });
  NodeAssert.match(broken.warnings[0], /line 2/u);

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
  NodeAssert.deepEqual(redaction.alwaysRedact, ["Some Client Name"]);
  NodeAssert.deepEqual(redaction.replacements, { "Some Client Name": "a client" });
  NodeAssert.equal(warnings.length, 2);
});

NodeTest.test("redaction: save then load is lossless", (t) => {
  const paths = tempPaths(t);
  const redaction = {
    alwaysRedact: ["Acme Corp", "Project Nimbus"],
    replacements: { "Acme Corp": "a client", "Project Nimbus": "an internal project" },
  };
  saveRedaction(paths, redaction);

  const text = NodeFS.readFileSync(paths.redactionYaml, "utf8");
  NodeAssert.match(text, /^# \/worklog redaction list/u);
  NodeAssert.match(text, /version: 1/u);

  const loaded = loadRedaction(paths);
  NodeAssert.deepEqual(loaded.warnings, []);
  NodeAssert.deepEqual(loaded.redaction, redaction);

  // Empty is a legal state too.
  saveRedaction(paths, {});
  NodeAssert.deepEqual(loadRedaction(paths).redaction, { alwaysRedact: [], replacements: {} });
});

NodeTest.test("no public function throws on junk input", (t) => {
  const paths = tempPaths(t);
  for (const junk of [null, undefined, 42, "string", [], { projects: [] }]) {
    NodeAssert.doesNotThrow(() => settingsOf(junk));
    NodeAssert.doesNotThrow(() => identitiesOf(junk));
    NodeAssert.doesNotThrow(() => classify(junk, "a"));
    NodeAssert.doesNotThrow(() => matchProjectByRoot(junk, "/tmp/a"));
    NodeAssert.doesNotThrow(() => upsertProject(junk, "a", { roots: junk }));
    NodeAssert.doesNotThrow(() => projectKeyFor(junk, junk));
    NodeAssert.doesNotThrow(() => saveRegistry(paths, junk));
    NodeAssert.doesNotThrow(() => saveRedaction(paths, junk));
    NodeAssert.doesNotThrow(() => loadRegistry(paths));
    NodeAssert.doesNotThrow(() => loadRedaction(paths));
  }
});
