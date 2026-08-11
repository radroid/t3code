// Tests for lib/redact.mjs — the privacy gate.
//
// Two properties matter more than the rest and are asserted repeatedly: a clean report produces
// nothing at all (a noisy gate is an ignored gate), and a finding's excerpt never carries the
// secret it flagged (the gate must not become the leak). Every path here is synthetic; the real
// ~/.t3 and ~/.claude are never read.

import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import test, { after, before } from "node:test";

import {
  RULES,
  basenameOnly,
  formatFindings,
  hasErrors,
  lintFile,
  lintText,
  redactSlice,
} from "../lib/redact.mjs";

const HOME = "/Users/tester";

let sandbox = "";
const savedHome = process.env.HOME;

before(() => {
  sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worklog-"));
  // Every assertion passes `homeDir` explicitly; this only guarantees that a call which does not
  // cannot reach the real home directory.
  process.env.HOME = NodePath.join(sandbox, "home");
});

after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (sandbox !== "") NodeFS.rmSync(sandbox, { recursive: true, force: true });
});

/** A registry with one public project and one that may not be named. */
function registryFixture() {
  return {
    version: 1,
    identities: ["Raj D"],
    defaults: { activeGapMinutes: 30, singleEventMinutes: 1 },
    projects: {
      t3code: {
        displayName: "T3 Code (fork)",
        roots: [`${HOME}/Developer/t3code`],
        include: true,
        visibility: "public",
        confirmed: true,
      },
      northwind: {
        displayName: "Northwind",
        roots: [`${HOME}/Projects/northwind-books`],
        include: true,
        visibility: "generic",
        confirmed: true,
      },
    },
  };
}

function redactionFixture() {
  return {
    alwaysRedact: ["Acme Widgets", "zeta-corp.internal"],
    replacements: { "Acme Widgets": "a client" },
  };
}

function lint(text, extra = {}) {
  return lintText(text, {
    registry: registryFixture(),
    redaction: redactionFixture(),
    homeDir: HOME,
    ...extra,
  });
}

function ruleIds(findings) {
  return findings.map((finding) => finding.rule);
}

// A realistic day file: links to public PRs, a public project named, a client described but never
// identified, a public branch mentioned. Nothing here may produce a finding.
const CLEAN_REPORT = `# Work log — 2026-08-10

**Active:** 6h 10m · **Agent runtime:** 19h 42m · **Sessions:** 12 · **Commits:** 9

## T3 Code (fork)

Shipped the update-delivery retry path: the release relay now retries a failed notify and
surfaces a Durable Object failure as a readable 503 instead of a bare 500. Merged in
[#66](https://github.com/radroid/t3code/pull/66) once a control run proved the publish had
already applied.

Anchored the auto-resume capsule to the composer's measured box, which fixes the half-pixel
drift on a narrow window ([#67](https://github.com/radroid/t3code/pull/67)), and landed the
day's sync on \`t3x/sync-20260810\`.

## Client work

Spent the afternoon on a client project: finished the invoice import, cut the retry budget from
four attempts to two, and left the migration behind a flag until Monday's review.

## Notes

Nine commits, two pull requests merged, 1.2k lines added and 340 removed across 41 files.
Tomorrow: finish the flag removal and re-baseline the seam ledger.
`;

// Assembled at runtime, never written as a literal. GitHub's push protection scans source files
// for exactly these shapes and rejected the first push of this file over the Slack entry — which
// is the rule under test working, one layer up. Splitting the prefix keeps the fixtures honest
// (lintText still sees the whole token) without parking a scanner hit in the repo forever.
const SECRETS = [
  ["sk-", "ant-api03-Ab3dEfGhIjKlMnOpQrStUvWx"].join(""),
  ["ghp", "_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join(""),
  ["github", "_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz012345"].join(""),
  ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
  ["xoxb", "-123456789012-abcdefghijklmno"].join(""),
  "0123456789abcdef0123456789abcdef0123",
];

test("a clean report produces no findings at all", () => {
  const findings = lint(CLEAN_REPORT);
  assert.deepEqual(findings, [], `unexpected findings:\n${formatFindings(findings)}`);
  assert.equal(hasErrors(findings), false);
});

test("the catalogue is well formed and covers every documented rule", () => {
  const required = [
    "home-path",
    "tilde-path",
    "email",
    "secret-shape",
    "redact-term",
    "private-project",
    "private-branch",
    "raw-quote",
    "long-path",
  ];
  const ids = RULES.map((rule) => rule.id);
  for (const id of required) assert.ok(ids.includes(id), `missing rule ${id}`);
  assert.equal(new Set(ids).size, ids.length, "rule ids must be unique");
  for (const rule of RULES) {
    assert.ok(["error", "warn"].includes(rule.severity), `${rule.id}: bad severity`);
    assert.ok(rule.title.length > 0 && rule.hint.length > 0, `${rule.id}: needs a title and hint`);
    assert.ok(Object.isFrozen(rule));
  }
  assert.equal(RULES.find((rule) => rule.id === "raw-quote").severity, "warn");
  assert.equal(RULES.find((rule) => rule.id === "long-path").severity, "warn");
  assert.equal(RULES.find((rule) => rule.id === "private-branch").severity, "warn");
});

test("home-path: an absolute path through a home directory is an error", () => {
  const findings = lint(`Rewrote ${HOME}/Developer/t3code/lib/redact.mjs today.`);
  assert.deepEqual(ruleIds(findings), ["home-path"]);
  assert.equal(findings[0].severity, "error");
  assert.equal(findings[0].line, 1);
  assert.equal(findings[0].column, 9);
  assert.ok(!findings[0].excerpt.includes(HOME), "the excerpt leaked the home directory");
  assert.ok(findings[0].excerpt.includes("redact.mjs"), "the basename keeps the hint actionable");
});

test("home-path: another machine's home is caught too, but a basename is clean", () => {
  assert.deepEqual(ruleIds(lint("Fixed /Users/someone/Sites/app/main.js.")), ["home-path"]);
  assert.deepEqual(ruleIds(lint("Fixed /home/build/ci/run.sh.")), ["home-path"]);
  assert.deepEqual(lint("Rewrote redact.mjs today."), []);
});

test("tilde-path: `~/…` is an error, a bare `~` in prose is not", () => {
  const findings = lint("Notes live in ~/Developer/worklog/days/2026-08-10.md now.");
  assert.deepEqual(ruleIds(findings), ["tilde-path"]);
  assert.ok(!findings[0].excerpt.includes("Developer"));
  assert.deepEqual(lint("Took ~30 minutes, give or take."), []);
});

test("email: an address is an error, a bare handle is not", () => {
  const findings = lint("Handed off to dana.reed@example.com for review.");
  assert.deepEqual(ruleIds(findings), ["email"]);
  assert.ok(!findings[0].excerpt.includes("dana.reed@example.com"));
  assert.deepEqual(lint("Handed off to @danareed for review."), []);
});

test("secret-shape: every documented shape fires and none of them survive the excerpt", () => {
  for (const secret of SECRETS) {
    const findings = lint(`Deployed with ${secret} in the header.`);
    assert.deepEqual(ruleIds(findings), ["secret-shape"], `missed ${secret}`);
    assert.ok(!findings[0].excerpt.includes(secret), `excerpt leaked ${secret}`);
    assert.ok(findings[0].excerpt.length <= 120);
  }
});

test("secret-shape: bearer tokens, PEM headers and key=value pairs fire", () => {
  const bearer = lint("Sent Authorization: Bearer aB3dEf9hIjKlMnOp to the relay.");
  assert.deepEqual(ruleIds(bearer), ["secret-shape"]);
  assert.ok(!bearer[0].excerpt.includes("aB3dEf9hIjKlMnOp"));
  // The label survives masking, which is what makes the finding actionable.
  assert.ok(bearer[0].excerpt.includes("Bearer"));

  assert.deepEqual(ruleIds(lint("Pasted -----BEGIN RSA PRIVATE KEY----- into the issue.")), [
    "secret-shape",
  ]);

  const pair = lint("Set DB_PASSWORD=hunter2correcthorse in the env file.");
  assert.deepEqual(ruleIds(pair), ["secret-shape"]);
  assert.ok(!pair[0].excerpt.includes("hunter2correcthorse"));
  assert.ok(pair[0].excerpt.includes("DB_PASSWORD="));
});

test("secret-shape: ordinary prose about keys is not a finding", () => {
  assert.deepEqual(lint("Rotated the API key and shortened the session timeout."), []);
  assert.deepEqual(lint("Cherry-picked 4b126c02f onto the release branch."), []);
  assert.deepEqual(lint("Read the risk-register before the sk demo."), []);
});

test("redact-term: an always-redact term is an error, case-insensitively and whole-word", () => {
  const findings = lint("Finished the acme widgets migration.");
  assert.deepEqual(ruleIds(findings), ["redact-term"]);
  assert.ok(!findings[0].excerpt.toLowerCase().includes("acme widgets"));
  // Word-like terms do not fire inside a longer word.
  assert.deepEqual(lint("Finished the acmes widgetsxyz migration."), []);
  // A term carrying punctuation is matched as a substring, on purpose.
  assert.deepEqual(ruleIds(lint("Pointed it at zeta-corp.internalx for now.")), ["redact-term"]);
  assert.deepEqual(lint("Shipped the widgets refactor."), []);
});

test("private-project: a non-public key, display name or root basename is an error", () => {
  assert.deepEqual(ruleIds(lint("Shipped the Northwind importer.")), ["private-project"]);
  assert.deepEqual(ruleIds(lint("Shipped the northwind-books importer.")), ["private-project"]);
  // A public project may be named freely — that is the whole point of confirming it.
  assert.deepEqual(lint("Shipped the t3code updater, see T3 Code (fork)."), []);
});

test("private-project: short terms and matches inside longer words are skipped", () => {
  const registry = registryFixture();
  registry.projects.cli = {
    displayName: "CLI",
    roots: [`${HOME}/Projects/cli`],
    include: true,
    visibility: "private",
    confirmed: true,
  };
  assert.deepEqual(lint("Refactored the cli entry point.", { registry }), []);
  assert.deepEqual(lint("Northwinds are seasonal around here."), []);
});

test("private-project: an unconfirmed or excluded project is still not nameable", () => {
  const registry = registryFixture();
  registry.projects.t3code.confirmed = false;
  assert.deepEqual(ruleIds(lint("Shipped the t3code updater.", { registry })), ["private-project"]);

  const excluded = registryFixture();
  excluded.projects.t3code.include = false;
  assert.deepEqual(ruleIds(lint("Shipped the t3code updater.", { registry: excluded })), [
    "private-project",
  ]);
});

test("private-branch: a branch attributable to a non-public project warns", () => {
  const byToken = lint("Rebased fix/northwind-invoices onto main.");
  assert.ok(ruleIds(byToken).includes("private-branch"));
  assert.ok(ruleIds(byToken).includes("private-project"));
  assert.equal(byToken.find((f) => f.rule === "private-branch").severity, "warn");

  // Attribution can also come from the line: the branch itself names nothing private.
  const byLine = lint("Northwind: shipped the importer on feat/import-v2 this morning.");
  assert.ok(ruleIds(byLine).includes("private-branch"));
});

test("private-branch: an unattributable branch and a file path are left alone", () => {
  assert.deepEqual(lint("Merged feat/keyboard-shortcuts today."), []);
  assert.deepEqual(lint("Merged t3x/sync-20260810 and moved on."), []);
  assert.deepEqual(lint("Touched lib/redact.mjs and nothing else."), []);
  // No non-public project in the registry means the rule cannot fire at all.
  const publicOnly = { version: 1, projects: { t3code: registryFixture().projects.t3code } };
  assert.deepEqual(lint("Rebased fix/northwind-invoices onto main.", { registry: publicOnly }), []);
});

test("raw-quote: long quotes and fences warn, short ones do not", () => {
  const quote = ["Context:", "> line one", "> line two", "> line three", "> line four", ""].join(
    "\n",
  );
  const findings = lint(quote);
  assert.deepEqual(ruleIds(findings), ["raw-quote"]);
  assert.equal(findings[0].line, 2);
  assert.equal(findings[0].excerpt, "blockquote — 4 lines");
  assert.deepEqual(lint("Context:\n> line one\n> line two\n"), []);

  const fence = [
    "```js",
    "const a = 1;",
    "const b = 2;",
    "const c = 3;",
    "const d = 4;",
    "```",
    "",
  ];
  const fenced = lint(fence.join("\n"));
  assert.deepEqual(ruleIds(fenced), ["raw-quote"]);
  assert.equal(fenced[0].excerpt, "fenced block (js) — 4 lines");
  assert.deepEqual(lint("```\nconst a = 1;\nconst b = 2;\n```\n"), []);
});

test("raw-quote never swallows a finding inside the block", () => {
  const text = [
    "```sh",
    "export A=1",
    `export TOKEN=${SECRETS[1]}`,
    "export B=2",
    "export C=3",
    "```",
    "",
  ].join("\n");
  const findings = lint(text);
  assert.deepEqual(ruleIds(findings).sort(), ["raw-quote", "secret-shape"]);
  const secret = findings.find((finding) => finding.rule === "secret-shape");
  assert.ok(!secret.excerpt.includes(SECRETS[1]));
});

test("long-path: a deep path warns, a shallow one does not", () => {
  const findings = lint("Reworked scripts/t3x/worklog/lib/redact.mjs this afternoon.");
  assert.deepEqual(ruleIds(findings), ["long-path"]);
  assert.equal(findings[0].severity, "warn");
  assert.ok(findings[0].excerpt.includes("redact.mjs"));
  assert.deepEqual(lint("Reworked lib/redact.mjs this afternoon."), []);
});

test("long-path: a public code-host link is exempt, another host is not", () => {
  assert.deepEqual(lint("Landed [#66](https://github.com/radroid/t3code/pull/66) at last."), []);
  assert.deepEqual(lint("Landed <https://gitlab.com/radroid/t3code/-/merge_requests/4>."), []);
  assert.deepEqual(ruleIds(lint("Deployed via https://ci.example.com/jobs/build/412 tonight.")), [
    "long-path",
  ]);
});

test("a public-host link that names a private project is not exempt", () => {
  const findings = lint("Opened https://github.com/acme/northwind-books/pull/3 for review.");
  assert.ok(ruleIds(findings).includes("private-project"));
  assert.ok(ruleIds(findings).includes("long-path"));
});

test("a rule matching inside a higher-priority rule's span is dropped", () => {
  // The deep path inside the home path would otherwise be reported a second time as long-path.
  const home = ruleIds(lint(`Wrote ${HOME}/Projects/northwind-books/src/import.ts today.`));
  assert.ok(home.includes("home-path"));
  assert.ok(!home.includes("long-path"), "long-path is covered by home-path");
  assert.ok(!home.includes("private-branch"), "private-branch is covered by home-path");

  const tilde = ruleIds(lint("Wrote ~/Projects/northwind-books/src/import.ts today."));
  assert.ok(tilde.includes("tilde-path"));
  assert.ok(!tilde.includes("long-path"));
  assert.deepEqual(ruleIds(lint("Reworked scripts/t3x/worklog/lib/redact.mjs.")), ["long-path"]);
});

test("an excerpt masks every leak on its line, not only its own match", () => {
  const line = `Wrote ${HOME}/Developer/t3code/lib/a.mjs, mailed dana.reed@example.com, key ${SECRETS[3]}.`;
  const findings = lint(line);
  assert.deepEqual(ruleIds(findings), ["home-path", "email", "secret-shape"]);
  for (const finding of findings) {
    assert.ok(!finding.excerpt.includes(HOME), `${finding.rule} leaked the home path`);
    assert.ok(
      !finding.excerpt.includes("dana.reed@example.com"),
      `${finding.rule} leaked an email`,
    );
    assert.ok(!finding.excerpt.includes(SECRETS[3]), `${finding.rule} leaked a key`);
  }
});

test("findings are sorted by line then column", () => {
  const text = [
    "Nothing to see here.",
    `Two leaks: ${SECRETS[3]} and dana.reed@example.com in one line.`,
    "Then ~/Developer/worklog/days/x.md at the end.",
  ].join("\n");
  const findings = lint(text);
  assert.deepEqual(ruleIds(findings), ["secret-shape", "email", "tilde-path"]);
  assert.deepEqual(
    findings.map((finding) => finding.line),
    [2, 2, 3],
  );
  assert.ok(findings[0].column < findings[1].column);
  for (const finding of findings) assert.ok(finding.column >= 1 && finding.line >= 1);
});

test("line and column survive CRLF input", () => {
  const findings = lint(`ok\r\nleaked ${SECRETS[0]} here\r\n`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
  assert.equal(findings[0].column, 8);
});

test("an excerpt is clipped to 120 characters around the match", () => {
  const filler = "context ".repeat(40);
  const findings = lint(`${filler}${SECRETS[0]}${filler}`);
  assert.deepEqual(ruleIds(findings), ["secret-shape"]);
  assert.ok(findings[0].excerpt.length <= 120, findings[0].excerpt);
  assert.ok(findings[0].excerpt.includes("…"), "a clipped excerpt says so");
  assert.ok(!findings[0].excerpt.includes(SECRETS[0]));
});

test("allow suppresses rules by id without disturbing the others", () => {
  const text = `Reworked scripts/t3x/worklog/lib/redact.mjs and set DB_PASSWORD=hunter2correcthorse.`;
  assert.deepEqual(ruleIds(lint(text)).sort(), ["long-path", "secret-shape"]);
  assert.deepEqual(ruleIds(lint(text, { allow: ["long-path"] })), ["secret-shape"]);
  assert.deepEqual(lint(text, { allow: ["long-path", "secret-shape"] }), []);
  assert.deepEqual(ruleIds(lint(text, { allow: ["nonsense"] })).sort(), [
    "long-path",
    "secret-shape",
  ]);
});

test("hasErrors separates blocking findings from advice", () => {
  assert.equal(hasErrors(lint("Reworked scripts/t3x/worklog/lib/redact.mjs.")), false);
  assert.equal(hasErrors(lint(`Wrote ${HOME}/x/y.md.`)), true);
  assert.equal(hasErrors([]), false);
  assert.equal(hasErrors(null), false);
});

test("formatFindings renders every finding once and each hint once", () => {
  const text = [
    `Wrote ${HOME}/Developer/t3code/lib/a.mjs and ${HOME}/Developer/t3code/lib/b.mjs.`,
    "Reworked scripts/t3x/worklog/lib/redact.mjs.",
  ].join("\n");
  const report = formatFindings(lint(text));
  assert.match(report, /^2 errors, 1 warning$/mu);
  assert.equal(report.split("home-path").length - 1, 2);
  assert.equal(report.split("hint:").length - 1, 2, "one hint per rule, not per finding");
  assert.ok(!report.includes(HOME), "the report itself must be safe to print");
  assert.equal(formatFindings([]), "No redaction findings.");
  assert.equal(formatFindings("nope"), "No redaction findings.");
});

test("lintFile reports findings with a file path", () => {
  const file = NodePath.join(sandbox, "day.md");
  NodeFS.writeFileSync(file, `Wrote ${HOME}/Developer/t3code/lib/redact.mjs.\n`, "utf8");
  const findings = lintFile(file, { registry: registryFixture(), homeDir: HOME });
  assert.deepEqual(ruleIds(findings), ["home-path"]);
  assert.equal(findings[0].filePath, file);
  assert.ok(formatFindings(findings).includes(file));
});

test("lintFile fails closed on an unreadable file", () => {
  const missing = NodePath.join(sandbox, "does-not-exist.md");
  const findings = lintFile(missing, { homeDir: HOME });
  assert.deepEqual(ruleIds(findings), ["lint-unavailable"]);
  assert.equal(hasErrors(findings), true, "an unchecked file must not read as clean");
  assert.ok(findings[0].excerpt.includes("ENOENT"));
  assert.ok(!findings[0].excerpt.includes(sandbox), "the excerpt must not carry the path");
});

test("lintText never throws on hostile input", () => {
  assert.deepEqual(lintText(undefined), []);
  assert.deepEqual(lintText(""), []);
  assert.deepEqual(lintText(42, { registry: null }), []);
  assert.ok(Array.isArray(lintText("hi", null)));
  assert.ok(Array.isArray(lintText("hi", { registry: { projects: 7 }, redaction: "nope" })));
  assert.ok(Array.isArray(lintText("hi", { registry: { projects: { a: 5 } }, homeDir: 42 })));
  assert.ok(Array.isArray(lintText("hi", { allow: "long-path" })));
  const arrayRegistry = { projects: { northwind: registryFixture().projects.northwind } };
  assert.deepEqual(ruleIds(lintText("Shipped Northwind.", { registry: arrayRegistry })), [
    "private-project",
  ]);
});

test("redactSlice reduces home paths to a basename", () => {
  const options = { homeDir: HOME, redaction: redactionFixture() };
  assert.equal(
    redactSlice(`Bash: cd ${HOME}/Developer/t3code && pnpm test`, options),
    "Bash: cd t3code && pnpm test",
  );
  assert.equal(redactSlice(`Read ~/Developer/worklog/days/x.md`, options), "Read x.md");
  assert.equal(redactSlice(`Wrote /tmp/build/out/app.js`, options), "Wrote app.js");
  assert.equal(redactSlice(`At ${HOME} exactly`, options), "At ~ exactly");
  // A URL is not a filesystem path and must survive intact.
  assert.equal(
    redactSlice("See https://github.com/radroid/t3code/pull/66", options),
    "See https://github.com/radroid/t3code/pull/66",
  );
});

test("redactSlice removes secret shapes and email addresses", () => {
  const options = { homeDir: HOME, redaction: redactionFixture() };
  for (const secret of SECRETS) {
    const out = redactSlice(`token=${secret}`, options);
    assert.ok(!out.includes(secret), `redactSlice kept ${secret}`);
    assert.ok(out.includes("[redacted]"));
  }
  assert.equal(
    redactSlice("Set DB_PASSWORD=hunter2correcthorse now", options),
    "Set DB_PASSWORD=[redacted] now",
  );
  assert.equal(redactSlice("From dana.reed@example.com", options), "From [redacted]");
});

test("redactSlice applies always_redact terms and their replacements", () => {
  const options = { homeDir: HOME, redaction: redactionFixture() };
  assert.equal(redactSlice("Met with Acme Widgets today", options), "Met with a client today");
  assert.equal(redactSlice("Met with ACME  widgets today", options), "Met with a client today");
  assert.equal(redactSlice("Host zeta-corp.internal is down", options), "Host [redacted] is down");

  // A replacement that still contains the term would leak, and would not be idempotent.
  const circular = {
    homeDir: HOME,
    redaction: {
      alwaysRedact: ["Acme Widgets"],
      replacements: { "Acme Widgets": "Acme Widgets Inc" },
    },
  };
  assert.equal(redactSlice("Met with Acme Widgets", circular), "Met with [redacted]");
});

test("redactSlice is idempotent", () => {
  const options = { homeDir: HOME, redaction: redactionFixture() };
  const slice = [
    `User: please fix ${HOME}/Projects/northwind-books/src/import.ts`,
    `Bash: curl -H "Authorization: Bearer ${SECRETS[0]}" https://api.example.com/v1/jobs`,
    "Assistant: Acme Widgets asked for the invoice import; wrote to ~/Downloads/notes.md",
    `git commit --author "Raj D <raj@example.com>" # ${SECRETS[5]}`,
    "Set api_key: abcd1234efgh in the config",
  ].join("\n");

  const once = redactSlice(slice, options);
  const twice = redactSlice(once, options);
  assert.equal(twice, once, "a second pass must be a no-op");
  assert.ok(!once.includes(HOME));
  assert.ok(!once.includes("northwind-books/src"));
  assert.ok(!once.includes("Acme Widgets"));
  assert.ok(!once.includes("raj@example.com"));
  for (const secret of [SECRETS[0], SECRETS[5]]) assert.ok(!once.includes(secret));
  // The shape of the transcript survives: it is still readable prose for a subagent.
  assert.ok(once.includes("please fix import.ts"));
  assert.ok(once.includes("invoice import"));
});

test("redactSlice degrades safely on bad input", () => {
  assert.equal(redactSlice(undefined), "");
  assert.equal(redactSlice(""), "");
  assert.equal(redactSlice(null, { homeDir: 5 }), "");
  assert.equal(redactSlice("plain text", null), "plain text");
  assert.equal(redactSlice("plain text", { redaction: "nope", homeDir: 5 }), "plain text");
});

test("basenameOnly keeps only the last segment", () => {
  assert.equal(basenameOnly("/Users/tester/Developer/t3code/lib/redact.mjs"), "redact.mjs");
  assert.equal(basenameOnly("~/Developer/worklog"), "worklog");
  assert.equal(basenameOnly("lib/redact.mjs"), "redact.mjs");
  assert.equal(basenameOnly("redact.mjs"), "redact.mjs");
  assert.equal(basenameOnly("/Users/tester/Developer/"), "Developer");
  assert.equal(basenameOnly("/"), "/");
  assert.equal(basenameOnly("C:\\Users\\tester\\app.exe"), "app.exe");
  assert.equal(basenameOnly(""), "");
  assert.equal(basenameOnly(undefined), "");
  assert.equal(basenameOnly(42), "");
});

test("no excerpt anywhere ever carries the value it flagged", () => {
  const registry = registryFixture();
  const text = [
    `Home ${HOME}/Projects/northwind-books/src/import.ts`,
    "Tilde ~/Developer/worklog/days/2026-08-10.md",
    "Mail dana.reed@example.com",
    ...SECRETS.map((secret) => `Key ${secret}`),
    "Term Acme Widgets",
    "Project Northwind",
    "Branch fix/northwind-invoices",
    "Path scripts/t3x/worklog/lib/redact.mjs",
  ].join("\n");
  const findings = lint(text, { registry });
  assert.ok(findings.length >= 10, `expected a finding per line, got ${findings.length}`);

  const forbidden = [
    ...SECRETS,
    "dana.reed@example.com",
    `${HOME}/Projects/northwind-books`,
    "~/Developer/worklog/days",
    "Acme Widgets",
  ];
  for (const finding of findings) {
    assert.ok(finding.excerpt.length <= 120, `excerpt too long: ${finding.excerpt}`);
    for (const value of forbidden) {
      assert.ok(
        !finding.excerpt.includes(value),
        `${finding.rule} excerpt leaked "${value}": ${finding.excerpt}`,
      );
    }
  }
  assert.ok(!formatFindings(findings).includes("Acme Widgets"));
});
