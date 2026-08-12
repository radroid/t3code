// Tests for lib/redact.mjs — the privacy gate.
//
// Two properties matter more than the rest and are asserted repeatedly: a clean report produces
// nothing at all (a noisy gate is an ignored gate), and a finding's excerpt never carries the
// secret it flagged (the gate must not become the leak). Every path here is synthetic; the real
// ~/.t3 and ~/.claude are never read.

import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

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

NodeTest.before(() => {
  sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worklog-"));
  // Every assertion passes `homeDir` explicitly; this only guarantees that a call which does not
  // cannot reach the real home directory.
  process.env.HOME = NodePath.join(sandbox, "home");
});

NodeTest.after(() => {
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
day's sync on \`coil/sync-20260810\`.

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
  // The bodies are a repeated fragment rather than anything entropic, for the same reason as
  // above: these are the exact shapes a scanner rejects a push over.
  ["eyJ", "hbGciOiJIUzI1NiJ9.eyJzdWIiOiJ3b3JrbG9nIn0.c2lnbmF0dXJlLXZhbHVl"].join(""), // JWT
  ["AIza", "Sy".concat("b3dEfGhIjK".repeat(4)).slice(0, 35)].join(""), // Google API key
  ["glpat", "-", "b3dEfGhIjK".repeat(3).slice(0, 24)].join(""), // GitLab PAT
  ["npm", "_", "b3dEfGhIjK".repeat(4).slice(0, 36)].join(""), // npm automation token
  ["dop", "_v1_", "a1b2c3d4".repeat(8)].join(""), // DigitalOcean PAT
];

NodeTest.test("a clean report produces no findings at all", () => {
  const findings = lint(CLEAN_REPORT);
  NodeAssert.deepEqual(findings, [], `unexpected findings:\n${formatFindings(findings)}`);
  NodeAssert.equal(hasErrors(findings), false);
});

NodeTest.test("the catalogue is well formed and covers every documented rule", () => {
  const required = [
    "home-path",
    "tilde-path",
    "email",
    "secret-shape",
    "redact-term",
    "private-project",
    "unclassified-project",
    "private-branch",
    "raw-quote",
    "long-path",
  ];
  const ids = RULES.map((rule) => rule.id);
  for (const id of required) NodeAssert.ok(ids.includes(id), `missing rule ${id}`);
  NodeAssert.equal(new Set(ids).size, ids.length, "rule ids must be unique");
  for (const rule of RULES) {
    NodeAssert.ok(["error", "warn"].includes(rule.severity), `${rule.id}: bad severity`);
    NodeAssert.ok(
      rule.title.length > 0 && rule.hint.length > 0,
      `${rule.id}: needs a title and hint`,
    );
    NodeAssert.ok(Object.isFrozen(rule));
  }
  NodeAssert.equal(RULES.find((rule) => rule.id === "raw-quote").severity, "warn");
  NodeAssert.equal(RULES.find((rule) => rule.id === "long-path").severity, "warn");
  NodeAssert.equal(RULES.find((rule) => rule.id === "private-branch").severity, "warn");
});

NodeTest.test("home-path: an absolute path through a home directory is an error", () => {
  const findings = lint(`Rewrote ${HOME}/Developer/t3code/lib/redact.mjs today.`);
  NodeAssert.deepEqual(ruleIds(findings), ["home-path"]);
  NodeAssert.equal(findings[0].severity, "error");
  NodeAssert.equal(findings[0].line, 1);
  NodeAssert.equal(findings[0].column, 9);
  NodeAssert.ok(!findings[0].excerpt.includes(HOME), "the excerpt leaked the home directory");
  NodeAssert.ok(
    findings[0].excerpt.includes("redact.mjs"),
    "the basename keeps the hint actionable",
  );
});

NodeTest.test("home-path: another machine's home is caught too, but a basename is clean", () => {
  NodeAssert.deepEqual(ruleIds(lint("Fixed /Users/someone/Sites/app/main.js.")), ["home-path"]);
  NodeAssert.deepEqual(ruleIds(lint("Fixed /home/build/ci/run.sh.")), ["home-path"]);
  NodeAssert.deepEqual(lint("Rewrote redact.mjs today."), []);
});

NodeTest.test("tilde-path: `~/…` is an error, a bare `~` in prose is not", () => {
  const findings = lint("Notes live in ~/Developer/worklog/days/2026-08-10.md now.");
  NodeAssert.deepEqual(ruleIds(findings), ["tilde-path"]);
  NodeAssert.ok(!findings[0].excerpt.includes("Developer"));
  NodeAssert.deepEqual(lint("Took ~30 minutes, give or take."), []);
});

NodeTest.test("email: an address is an error, a bare handle is not", () => {
  const findings = lint("Handed off to dana.reed@example.com for review.");
  NodeAssert.deepEqual(ruleIds(findings), ["email"]);
  NodeAssert.ok(!findings[0].excerpt.includes("dana.reed@example.com"));
  NodeAssert.deepEqual(lint("Handed off to @danareed for review."), []);
});

NodeTest.test(
  "secret-shape: every documented shape fires and none of them survive the excerpt",
  () => {
    for (const secret of SECRETS) {
      const findings = lint(`Deployed with ${secret} in the header.`);
      NodeAssert.deepEqual(ruleIds(findings), ["secret-shape"], `missed ${secret}`);
      NodeAssert.ok(!findings[0].excerpt.includes(secret), `excerpt leaked ${secret}`);
      NodeAssert.ok(findings[0].excerpt.length <= 120);
    }
  },
);

NodeTest.test("secret-shape: bearer tokens, PEM headers and key=value pairs fire", () => {
  const bearer = lint("Sent Authorization: Bearer aB3dEf9hIjKlMnOp to the relay.");
  NodeAssert.deepEqual(ruleIds(bearer), ["secret-shape"]);
  NodeAssert.ok(!bearer[0].excerpt.includes("aB3dEf9hIjKlMnOp"));
  // The label survives masking, which is what makes the finding actionable.
  NodeAssert.ok(bearer[0].excerpt.includes("Bearer"));

  NodeAssert.deepEqual(ruleIds(lint("Pasted -----BEGIN RSA PRIVATE KEY----- into the issue.")), [
    "secret-shape",
  ]);

  const pair = lint("Set DB_PASSWORD=hunter2correcthorse in the env file.");
  NodeAssert.deepEqual(ruleIds(pair), ["secret-shape"]);
  NodeAssert.ok(!pair[0].excerpt.includes("hunter2correcthorse"));
  NodeAssert.ok(pair[0].excerpt.includes("DB_PASSWORD="));
});

NodeTest.test("secret-shape: token, auth and credential assignments fire", () => {
  // `token` is the commonest spelling of all and was the gap that let a real one through.
  const cases = [
    ["Set ACCESS_TOKEN=s3cr3t-value-here in the env file.", "ACCESS_TOKEN=", "s3cr3t-value-here"],
    ["Exported auth=zzTopSecretValue before the run.", "auth=", "zzTopSecretValue"],
    ['Wrote credential: "hunter2correcthorse" to the config.', "credential", "hunter2correcthorse"],
    [
      "Set passphrase=correct-horse-battery in the keychain.",
      "passphrase=",
      "correct-horse-battery",
    ],
    ["Read private_key=MIIBOwIBAAJBAKq from the profile.", "private_key=", "MIIBOwIBAAJBAKq"],
    ["Sent Authorization: Basic dXNlcjpwYXNzd29yZA to the API.", "Basic", "dXNlcjpwYXNzd29yZA"],
  ];
  for (const [line, label, secret] of cases) {
    const findings = lint(line);
    NodeAssert.deepEqual(ruleIds(findings), ["secret-shape"], `missed: ${line}`);
    NodeAssert.ok(!findings[0].excerpt.includes(secret), `excerpt leaked ${secret}`);
    // The label survives masking, which is what makes the finding actionable.
    NodeAssert.ok(
      findings[0].excerpt.includes(label),
      `excerpt lost the label: ${findings[0].excerpt}`,
    );
  }
});

NodeTest.test("secret-shape: ordinary prose about keys is not a finding", () => {
  NodeAssert.deepEqual(lint("Rotated the API key and shortened the session timeout."), []);
  NodeAssert.deepEqual(lint("Cherry-picked 4b126c02f onto the release branch."), []);
  NodeAssert.deepEqual(lint("Read the risk-register before the sk demo."), []);
  // The credential keys are the noisiest words in engineering prose; each of these is a topic,
  // not an assignment, and a gate that fires on them is a gate the reader stops reading.
  NodeAssert.deepEqual(lint("Reworked the auth flow after the review."), []);
  NodeAssert.deepEqual(lint("Replaced the retry loop with a token bucket."), []);
  NodeAssert.deepEqual(lint("Wrote up private key rotation for the runbook."), []);
  NodeAssert.deepEqual(lint("Discussed credentials handling with the team."), []);
  NodeAssert.deepEqual(lint("Authored the passphrase section of the doc."), []);
});

NodeTest.test("redact-term: an always-redact term is an error, case-insensitively", () => {
  const findings = lint("Finished the acme widgets migration.");
  NodeAssert.deepEqual(ruleIds(findings), ["redact-term"]);
  NodeAssert.ok(!findings[0].excerpt.toLowerCase().includes("acme widgets"));
  // A multi-word term still needs its words in order, separated by whitespace: "acmes widgetsxyz"
  // never contains "acme<space>widgets".
  NodeAssert.deepEqual(lint("Finished the acmes widgetsxyz migration."), []);
  // A term carrying punctuation is matched as a substring, on purpose.
  NodeAssert.deepEqual(ruleIds(lint("Pointed it at zeta-corp.internalx for now.")), [
    "redact-term",
  ]);
  NodeAssert.deepEqual(lint("Shipped the widgets refactor."), []);
});

NodeTest.test("redact-term: a term the user wrote down fires inside a longer token", () => {
  // The list is curated by hand — "never let this through" beats "only as a whole word", because
  // the noise cost is one edit and the failure cost is a client name on a public timeline.
  const redaction = { alwaysRedact: ["northwind"], replacements: { northwind: "a retail client" } };
  const registry = { version: 1, projects: { t3code: registryFixture().projects.t3code } };
  const findings = lint("Deployed northwindretail-prod this morning.", { redaction, registry });
  NodeAssert.deepEqual(ruleIds(findings), ["redact-term"]);
  NodeAssert.ok(!findings[0].excerpt.toLowerCase().includes("northwindretail"));
  NodeAssert.equal(
    redactSlice("Deployed northwindretail-prod", { homeDir: HOME, redaction }),
    "Deployed a retail clientretail-prod",
  );
});

NodeTest.test(
  "private-project: a non-public key, display name or root basename is an error",
  () => {
    NodeAssert.deepEqual(ruleIds(lint("Shipped the Northwind importer.")), ["private-project"]);
    NodeAssert.deepEqual(ruleIds(lint("Shipped the northwind-books importer.")), [
      "private-project",
    ]);
    // A public project may be named freely — that is the whole point of confirming it.
    NodeAssert.deepEqual(lint("Shipped the t3code updater, see T3 Code (fork)."), []);
  },
);

NodeTest.test(
  "private-project: a short term is skipped, but a longer token containing one is not",
  () => {
    const registry = registryFixture();
    registry.projects.cli = {
      displayName: "CLI",
      roots: [`${HOME}/Projects/cli`],
      include: true,
      visibility: "private",
      confirmed: true,
    };
    // Below MIN_PROJECT_TERM: a three-letter key is a word, and would fire on every line of prose.
    NodeAssert.deepEqual(lint("Refactored the cli entry point.", { registry }), []);
    // Was previously clean, and that was the bug: `northwindretail-prod` is exactly how a client
    // name reaches a public post. A wrong hit here is one edit; a miss is unrecoverable.
    NodeAssert.deepEqual(ruleIds(lint("Deployed northwindretail-prod tonight.")), [
      "private-project",
    ]);
    NodeAssert.deepEqual(ruleIds(lint("Northwinds are seasonal around here.")), [
      "private-project",
    ]);
  },
);

NodeTest.test("private-project: an unconfirmed or excluded project is still not nameable", () => {
  const registry = registryFixture();
  registry.projects.t3code.confirmed = false;
  NodeAssert.deepEqual(ruleIds(lint("Shipped the t3code updater.", { registry })), [
    "private-project",
  ]);

  const excluded = registryFixture();
  excluded.projects.t3code.include = false;
  NodeAssert.deepEqual(ruleIds(lint("Shipped the t3code updater.", { registry: excluded })), [
    "private-project",
  ]);
});

// `extraTerms` exists because the registry can only police projects it knows about, and an
// unclassified project — the one class that must never be named — is by definition not in it.
NodeTest.test("extraTerms: an unclassified project is an error under its own rule", () => {
  const extraTerms = [{ term: "hollowfox", rule: "unclassified-project" }];
  const findings = lint("Shipped the Hollowfox importer today.", { extraTerms });
  NodeAssert.deepEqual(ruleIds(findings), ["unclassified-project"]);
  NodeAssert.equal(findings[0].severity, "error");
  NodeAssert.equal(hasErrors(findings), true);
  NodeAssert.ok(!findings[0].excerpt.toLowerCase().includes("hollowfox"), "the excerpt named it");
  NodeAssert.match(findings[0].hint, /classif/iu, "the hint must say what to do about it");

  // Matched like a redact-term: case-insensitive, and inside a longer token too.
  NodeAssert.deepEqual(ruleIds(lint("Deployed hollowfox-prod tonight.", { extraTerms })), [
    "unclassified-project",
  ]);
  NodeAssert.deepEqual(lint("Shipped the importer today.", { extraTerms }), []);
  NodeAssert.deepEqual(
    lint("Shipped Hollowfox.", { extraTerms, allow: ["unclassified-project"] }),
    [],
  );
});

NodeTest.test(
  "extraTerms: each entry keeps its rule id, and a malformed entry cannot silence a term",
  () => {
    const findings = lint("Ran the Hollowfox and Ridgeline migrations.", {
      extraTerms: [
        { term: "hollowfox", rule: "unclassified-project" },
        { term: "ridgeline", rule: "team-only" },
      ],
    });
    NodeAssert.deepEqual(ruleIds(findings), ["unclassified-project", "team-only"]);
    NodeAssert.equal(findings[1].severity, "error");
    NodeAssert.ok(findings[1].hint.length > 0, "an unregistered rule id still explains itself");
    for (const finding of findings) {
      NodeAssert.ok(!/hollowfox|ridgeline/iu.test(finding.excerpt), `leaked: ${finding.excerpt}`);
    }

    // A missing rule id falls back to the registered rule rather than dropping the term.
    NodeAssert.deepEqual(ruleIds(lint("Ran Hollowfox.", { extraTerms: [{ term: "hollowfox" }] })), [
      "unclassified-project",
    ]);
    NodeAssert.deepEqual(lint("Ran Hollowfox.", { extraTerms: "hollowfox" }), []);
    NodeAssert.deepEqual(lint("Ran Hollowfox.", { extraTerms: [null, 7, { term: "  " }] }), []);
  },
);

NodeTest.test("extraTerms reaches lintFile and prints safely", () => {
  const file = NodePath.join(sandbox, "extra.md");
  NodeFS.writeFileSync(file, "Shipped the Hollowfox importer.\n", "utf8");
  const findings = lintFile(file, {
    homeDir: HOME,
    extraTerms: [{ term: "hollowfox", rule: "unclassified-project" }],
  });
  NodeAssert.deepEqual(ruleIds(findings), ["unclassified-project"]);
  NodeAssert.equal(findings[0].filePath, file);
  const report = formatFindings(findings);
  NodeAssert.ok(report.includes("unclassified-project"));
  NodeAssert.ok(
    !report.toLowerCase().includes("hollowfox"),
    "the report itself must be safe to print",
  );
});

NodeTest.test("private-branch: a branch attributable to a non-public project warns", () => {
  const byToken = lint("Rebased fix/northwind-invoices onto main.");
  NodeAssert.ok(ruleIds(byToken).includes("private-branch"));
  NodeAssert.ok(ruleIds(byToken).includes("private-project"));
  NodeAssert.equal(byToken.find((f) => f.rule === "private-branch").severity, "warn");

  // Attribution can also come from the line: the branch itself names nothing private.
  const byLine = lint("Northwind: shipped the importer on feat/import-v2 this morning.");
  NodeAssert.ok(ruleIds(byLine).includes("private-branch"));
});

NodeTest.test("private-branch: an unattributable branch and a file path are left alone", () => {
  NodeAssert.deepEqual(lint("Merged feat/keyboard-shortcuts today."), []);
  NodeAssert.deepEqual(lint("Merged coil/sync-20260810 and moved on."), []);
  NodeAssert.deepEqual(lint("Touched lib/redact.mjs and nothing else."), []);
  // No non-public project in the registry means the rule cannot fire at all.
  const publicOnly = { version: 1, projects: { t3code: registryFixture().projects.t3code } };
  NodeAssert.deepEqual(
    lint("Rebased fix/northwind-invoices onto main.", { registry: publicOnly }),
    [],
  );
});

NodeTest.test("raw-quote: long quotes and fences warn, short ones do not", () => {
  const quote = ["Context:", "> line one", "> line two", "> line three", "> line four", ""].join(
    "\n",
  );
  const findings = lint(quote);
  NodeAssert.deepEqual(ruleIds(findings), ["raw-quote"]);
  NodeAssert.equal(findings[0].line, 2);
  NodeAssert.equal(findings[0].excerpt, "blockquote — 4 lines");
  NodeAssert.deepEqual(lint("Context:\n> line one\n> line two\n"), []);

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
  NodeAssert.deepEqual(ruleIds(fenced), ["raw-quote"]);
  NodeAssert.equal(fenced[0].excerpt, "fenced block (js) — 4 lines");
  NodeAssert.deepEqual(lint("```\nconst a = 1;\nconst b = 2;\n```\n"), []);
});

NodeTest.test("raw-quote never swallows a finding inside the block", () => {
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
  NodeAssert.deepEqual(ruleIds(findings).sort(), ["raw-quote", "secret-shape"]);
  const secret = findings.find((finding) => finding.rule === "secret-shape");
  NodeAssert.ok(!secret.excerpt.includes(SECRETS[1]));
});

NodeTest.test("long-path: a deep path warns, a shallow one does not", () => {
  const findings = lint("Reworked scripts/coil/worklog/lib/redact.mjs this afternoon.");
  NodeAssert.deepEqual(ruleIds(findings), ["long-path"]);
  NodeAssert.equal(findings[0].severity, "warn");
  NodeAssert.ok(findings[0].excerpt.includes("redact.mjs"));
  NodeAssert.deepEqual(lint("Reworked lib/redact.mjs this afternoon."), []);
});

NodeTest.test("long-path: a public code-host link is exempt, another host is not", () => {
  NodeAssert.deepEqual(
    lint("Landed [#66](https://github.com/radroid/t3code/pull/66) at last."),
    [],
  );
  NodeAssert.deepEqual(lint("Landed <https://gitlab.com/radroid/t3code/-/merge_requests/4>."), []);
  NodeAssert.deepEqual(
    ruleIds(lint("Deployed via https://ci.example.com/jobs/build/412 tonight.")),
    ["long-path"],
  );
});

NodeTest.test("a public-host link that names a private project is not exempt", () => {
  const findings = lint("Opened https://github.com/acme/northwind-books/pull/3 for review.");
  NodeAssert.ok(ruleIds(findings).includes("private-project"));
  NodeAssert.ok(ruleIds(findings).includes("long-path"));
});

NodeTest.test("a rule matching inside a higher-priority rule's span is dropped", () => {
  // The deep path inside the home path would otherwise be reported a second time as long-path.
  const home = ruleIds(lint(`Wrote ${HOME}/Projects/northwind-books/src/import.ts today.`));
  NodeAssert.ok(home.includes("home-path"));
  NodeAssert.ok(!home.includes("long-path"), "long-path is covered by home-path");
  NodeAssert.ok(!home.includes("private-branch"), "private-branch is covered by home-path");

  const tilde = ruleIds(lint("Wrote ~/Projects/northwind-books/src/import.ts today."));
  NodeAssert.ok(tilde.includes("tilde-path"));
  NodeAssert.ok(!tilde.includes("long-path"));
  NodeAssert.deepEqual(ruleIds(lint("Reworked scripts/coil/worklog/lib/redact.mjs.")), [
    "long-path",
  ]);
});

NodeTest.test("an excerpt masks every leak on its line, not only its own match", () => {
  const line = `Wrote ${HOME}/Developer/t3code/lib/a.mjs, mailed dana.reed@example.com, key ${SECRETS[3]}.`;
  const findings = lint(line);
  NodeAssert.deepEqual(ruleIds(findings), ["home-path", "email", "secret-shape"]);
  for (const finding of findings) {
    NodeAssert.ok(!finding.excerpt.includes(HOME), `${finding.rule} leaked the home path`);
    NodeAssert.ok(
      !finding.excerpt.includes("dana.reed@example.com"),
      `${finding.rule} leaked an email`,
    );
    NodeAssert.ok(!finding.excerpt.includes(SECRETS[3]), `${finding.rule} leaked a key`);
  }
});

NodeTest.test("findings are sorted by line then column", () => {
  const text = [
    "Nothing to see here.",
    `Two leaks: ${SECRETS[3]} and dana.reed@example.com in one line.`,
    "Then ~/Developer/worklog/days/x.md at the end.",
  ].join("\n");
  const findings = lint(text);
  NodeAssert.deepEqual(ruleIds(findings), ["secret-shape", "email", "tilde-path"]);
  NodeAssert.deepEqual(
    findings.map((finding) => finding.line),
    [2, 2, 3],
  );
  NodeAssert.ok(findings[0].column < findings[1].column);
  for (const finding of findings) NodeAssert.ok(finding.column >= 1 && finding.line >= 1);
});

NodeTest.test("line and column survive CRLF input", () => {
  const findings = lint(`ok\r\nleaked ${SECRETS[0]} here\r\n`);
  NodeAssert.equal(findings.length, 1);
  NodeAssert.equal(findings[0].line, 2);
  NodeAssert.equal(findings[0].column, 8);
});

NodeTest.test("an excerpt is clipped to 120 characters around the match", () => {
  const filler = "context ".repeat(40);
  const findings = lint(`${filler}${SECRETS[0]}${filler}`);
  NodeAssert.deepEqual(ruleIds(findings), ["secret-shape"]);
  NodeAssert.ok(findings[0].excerpt.length <= 120, findings[0].excerpt);
  NodeAssert.ok(findings[0].excerpt.includes("…"), "a clipped excerpt says so");
  NodeAssert.ok(!findings[0].excerpt.includes(SECRETS[0]));
});

NodeTest.test("allow suppresses rules by id without disturbing the others", () => {
  const text = `Reworked scripts/coil/worklog/lib/redact.mjs and set DB_PASSWORD=hunter2correcthorse.`;
  NodeAssert.deepEqual(ruleIds(lint(text)).sort(), ["long-path", "secret-shape"]);
  NodeAssert.deepEqual(ruleIds(lint(text, { allow: ["long-path"] })), ["secret-shape"]);
  NodeAssert.deepEqual(lint(text, { allow: ["long-path", "secret-shape"] }), []);
  NodeAssert.deepEqual(ruleIds(lint(text, { allow: ["nonsense"] })).sort(), [
    "long-path",
    "secret-shape",
  ]);
});

NodeTest.test("hasErrors separates blocking findings from advice", () => {
  NodeAssert.equal(hasErrors(lint("Reworked scripts/coil/worklog/lib/redact.mjs.")), false);
  NodeAssert.equal(hasErrors(lint(`Wrote ${HOME}/x/y.md.`)), true);
  NodeAssert.equal(hasErrors([]), false);
  NodeAssert.equal(hasErrors(null), false);
});

NodeTest.test("formatFindings renders every finding once and each hint once", () => {
  const text = [
    `Wrote ${HOME}/Developer/t3code/lib/a.mjs and ${HOME}/Developer/t3code/lib/b.mjs.`,
    "Reworked scripts/coil/worklog/lib/redact.mjs.",
  ].join("\n");
  const report = formatFindings(lint(text));
  NodeAssert.match(report, /^2 errors, 1 warning$/mu);
  NodeAssert.equal(report.split("home-path").length - 1, 2);
  NodeAssert.equal(report.split("hint:").length - 1, 2, "one hint per rule, not per finding");
  NodeAssert.ok(!report.includes(HOME), "the report itself must be safe to print");
  NodeAssert.equal(formatFindings([]), "No redaction findings.");
  NodeAssert.equal(formatFindings("nope"), "No redaction findings.");
});

NodeTest.test("lintFile reports findings with a file path", () => {
  const file = NodePath.join(sandbox, "day.md");
  NodeFS.writeFileSync(file, `Wrote ${HOME}/Developer/t3code/lib/redact.mjs.\n`, "utf8");
  const findings = lintFile(file, { registry: registryFixture(), homeDir: HOME });
  NodeAssert.deepEqual(ruleIds(findings), ["home-path"]);
  NodeAssert.equal(findings[0].filePath, file);
  NodeAssert.ok(formatFindings(findings).includes(file));
});

NodeTest.test("lintFile fails closed on an unreadable file", () => {
  const missing = NodePath.join(sandbox, "does-not-exist.md");
  const findings = lintFile(missing, { homeDir: HOME });
  NodeAssert.deepEqual(ruleIds(findings), ["lint-unavailable"]);
  NodeAssert.equal(hasErrors(findings), true, "an unchecked file must not read as clean");
  NodeAssert.ok(findings[0].excerpt.includes("ENOENT"));
  NodeAssert.ok(!findings[0].excerpt.includes(sandbox), "the excerpt must not carry the path");
});

NodeTest.test("lintText never throws on hostile input", () => {
  NodeAssert.deepEqual(lintText(undefined), []);
  NodeAssert.deepEqual(lintText(""), []);
  NodeAssert.deepEqual(lintText(42, { registry: null }), []);
  NodeAssert.ok(Array.isArray(lintText("hi", null)));
  NodeAssert.ok(Array.isArray(lintText("hi", { registry: { projects: 7 }, redaction: "nope" })));
  NodeAssert.ok(Array.isArray(lintText("hi", { registry: { projects: { a: 5 } }, homeDir: 42 })));
  NodeAssert.ok(Array.isArray(lintText("hi", { allow: "long-path" })));
  const arrayRegistry = { projects: { northwind: registryFixture().projects.northwind } };
  NodeAssert.deepEqual(ruleIds(lintText("Shipped Northwind.", { registry: arrayRegistry })), [
    "private-project",
  ]);
});

NodeTest.test("redactSlice reduces home paths to a basename", () => {
  const options = { homeDir: HOME, redaction: redactionFixture() };
  NodeAssert.equal(
    redactSlice(`Bash: cd ${HOME}/Developer/t3code && pnpm test`, options),
    "Bash: cd t3code && pnpm test",
  );
  NodeAssert.equal(redactSlice(`Read ~/Developer/worklog/days/x.md`, options), "Read x.md");
  NodeAssert.equal(redactSlice(`Wrote /tmp/build/out/app.js`, options), "Wrote app.js");
  NodeAssert.equal(redactSlice(`At ${HOME} exactly`, options), "At ~ exactly");
  // A URL is not a filesystem path and must survive intact.
  NodeAssert.equal(
    redactSlice("See https://github.com/radroid/t3code/pull/66", options),
    "See https://github.com/radroid/t3code/pull/66",
  );
});

NodeTest.test("redactSlice removes secret shapes and email addresses", () => {
  const options = { homeDir: HOME, redaction: redactionFixture() };
  for (const secret of SECRETS) {
    const out = redactSlice(`token=${secret}`, options);
    NodeAssert.ok(!out.includes(secret), `redactSlice kept ${secret}`);
    NodeAssert.ok(out.includes("[redacted]"));
  }
  NodeAssert.equal(
    redactSlice("Set DB_PASSWORD=hunter2correcthorse now", options),
    "Set DB_PASSWORD=[redacted] now",
  );
  NodeAssert.equal(redactSlice("From dana.reed@example.com", options), "From [redacted]");
});

NodeTest.test("redactSlice applies always_redact terms and their replacements", () => {
  const options = { homeDir: HOME, redaction: redactionFixture() };
  NodeAssert.equal(redactSlice("Met with Acme Widgets today", options), "Met with a client today");
  NodeAssert.equal(redactSlice("Met with ACME  widgets today", options), "Met with a client today");
  NodeAssert.equal(
    redactSlice("Host zeta-corp.internal is down", options),
    "Host [redacted] is down",
  );

  // A replacement that still contains the term would leak, and would not be idempotent.
  const circular = {
    homeDir: HOME,
    redaction: {
      alwaysRedact: ["Acme Widgets"],
      replacements: { "Acme Widgets": "Acme Widgets Inc" },
    },
  };
  NodeAssert.equal(redactSlice("Met with Acme Widgets", circular), "Met with [redacted]");
});

NodeTest.test("redactSlice is idempotent", () => {
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
  NodeAssert.equal(twice, once, "a second pass must be a no-op");
  NodeAssert.ok(!once.includes(HOME));
  NodeAssert.ok(!once.includes("northwind-books/src"));
  NodeAssert.ok(!once.includes("Acme Widgets"));
  NodeAssert.ok(!once.includes("raj@example.com"));
  for (const secret of [SECRETS[0], SECRETS[5]]) NodeAssert.ok(!once.includes(secret));
  // The shape of the transcript survives: it is still readable prose for a subagent.
  NodeAssert.ok(once.includes("please fix import.ts"));
  NodeAssert.ok(once.includes("invoice import"));
});

NodeTest.test("redactSlice degrades safely on bad input", () => {
  NodeAssert.equal(redactSlice(undefined), "");
  NodeAssert.equal(redactSlice(""), "");
  NodeAssert.equal(redactSlice(null, { homeDir: 5 }), "");
  NodeAssert.equal(redactSlice("plain text", null), "plain text");
  NodeAssert.equal(redactSlice("plain text", { redaction: "nope", homeDir: 5 }), "plain text");
});

NodeTest.test("basenameOnly keeps only the last segment", () => {
  NodeAssert.equal(basenameOnly("/Users/tester/Developer/t3code/lib/redact.mjs"), "redact.mjs");
  NodeAssert.equal(basenameOnly("~/Developer/worklog"), "worklog");
  NodeAssert.equal(basenameOnly("lib/redact.mjs"), "redact.mjs");
  NodeAssert.equal(basenameOnly("redact.mjs"), "redact.mjs");
  NodeAssert.equal(basenameOnly("/Users/tester/Developer/"), "Developer");
  NodeAssert.equal(basenameOnly("/"), "/");
  NodeAssert.equal(basenameOnly("C:\\Users\\tester\\app.exe"), "app.exe");
  NodeAssert.equal(basenameOnly(""), "");
  NodeAssert.equal(basenameOnly(undefined), "");
  NodeAssert.equal(basenameOnly(42), "");
});

NodeTest.test("no excerpt anywhere ever carries the value it flagged", () => {
  const registry = registryFixture();
  const text = [
    `Home ${HOME}/Projects/northwind-books/src/import.ts`,
    "Tilde ~/Developer/worklog/days/2026-08-10.md",
    "Mail dana.reed@example.com",
    ...SECRETS.map((secret) => `Key ${secret}`),
    "Term Acme Widgets",
    "Project Northwind",
    "Branch fix/northwind-invoices",
    "Path scripts/coil/worklog/lib/redact.mjs",
  ].join("\n");
  const findings = lint(text, { registry });
  NodeAssert.ok(findings.length >= 10, `expected a finding per line, got ${findings.length}`);

  const forbidden = [
    ...SECRETS,
    "dana.reed@example.com",
    `${HOME}/Projects/northwind-books`,
    "~/Developer/worklog/days",
    "Acme Widgets",
  ];
  for (const finding of findings) {
    NodeAssert.ok(finding.excerpt.length <= 120, `excerpt too long: ${finding.excerpt}`);
    for (const value of forbidden) {
      NodeAssert.ok(
        !finding.excerpt.includes(value),
        `${finding.rule} excerpt leaked "${value}": ${finding.excerpt}`,
      );
    }
  }
  NodeAssert.ok(!formatFindings(findings).includes("Acme Widgets"));
});
