import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { parseYaml, stringifyYaml, YamlLiteError } from "../lib/yamlLite.mjs";

/** Asserts that `text` fails to parse, and returns the error so the caller can inspect it. */
function parseError(text) {
  try {
    parseYaml(text);
  } catch (error) {
    NodeAssert.ok(error instanceof YamlLiteError, `expected a YamlLiteError, got ${error}`);
    return error;
  }
  return NodeAssert.fail(`expected a YamlLiteError for:\n${text}`);
}

/** Asserts the round-trip invariant: parse(stringify(x)) deep-equals x. */
function roundTrip(value, options) {
  const text = stringifyYaml(value, options);
  NodeAssert.deepEqual(parseYaml(text), value, `round-trip failed for:\n${text}`);
  return text;
}

NodeTest.test("parses the registry shape from the design doc", () => {
  const text = [
    "version: 1",
    "# Identities that count as my commits.",
    "identities:",
    "  - 25481060+radroid@users.noreply.github.com",
    "  - Raj D",
    "defaults:",
    "  active_gap_minutes: 30",
    "  single_event_minutes: 1",
    "projects:",
    "  t3code:",
    "    display_name: T3 Code (fork)",
    "    roots:",
    "      - /Users/rajdholakia/Developer/t3code",
    "    include: true",
    "    visibility: public          # public | generic | private",
    "    confirmed: true",
    "    link: https://github.com/radroid/t3code",
    "",
  ].join("\n");

  NodeAssert.deepEqual(parseYaml(text), {
    version: 1,
    identities: ["25481060+radroid@users.noreply.github.com", "Raj D"],
    defaults: { active_gap_minutes: 30, single_event_minutes: 1 },
    projects: {
      t3code: {
        display_name: "T3 Code (fork)",
        roots: ["/Users/rajdholakia/Developer/t3code"],
        include: true,
        visibility: "public",
        confirmed: true,
        link: "https://github.com/radroid/t3code",
      },
    },
  });
});

NodeTest.test("an empty or comment-only document is an empty map", () => {
  NodeAssert.deepEqual(parseYaml(""), {});
  NodeAssert.deepEqual(parseYaml("\n\n   \n"), {});
  NodeAssert.deepEqual(parseYaml("# just a note\n#and another\n"), {});
});

NodeTest.test("scalar types", () => {
  const parsed = parseYaml(
    [
      "t: true",
      "tUpper: True",
      "f: false",
      "n: null",
      "tilde: ~",
      "nothing:",
      "int: 42",
      "negative: -7",
      "plus: +3",
      "float: 1.5",
      "expo: 2e3",
      "leadingDot: .5",
      "bignum: 123456789012345678901234567890",
      "word: hello",
      "sentence: a few words here",
      "url: https://example.com/a#b",
      "colonInside: a:b",
    ].join("\n"),
  );
  NodeAssert.deepEqual(parsed, {
    t: true,
    tUpper: true,
    f: false,
    n: null,
    tilde: null,
    nothing: null,
    int: 42,
    negative: -7,
    plus: 3,
    float: 1.5,
    expo: 2000,
    leadingDot: 0.5,
    // Beyond Number.MAX_SAFE_INTEGER the round-trip would change the value, so it stays a string.
    bignum: "123456789012345678901234567890",
    word: "hello",
    sentence: "a few words here",
    url: "https://example.com/a#b",
    colonInside: "a:b",
  });
});

NodeTest.test("quoted scalars and their escapes", () => {
  const parsed = parseYaml(
    [
      'dq: "hello world"',
      'withNewline: "line one\\nline two"',
      'withQuote: "she said \\"hi\\""',
      'withTab: "a\\tb"',
      'withBackslash: "a\\\\b"',
      "sq: 'it''s fine'",
      "sqNoEscape: 'a\\nb'",
      'numberish: "42"',
      'boolish: "true"',
      'empty: ""',
      'hashInside: "a # b"',
      'trailing: "kept"   # a comment',
    ].join("\n"),
  );
  NodeAssert.deepEqual(parsed, {
    dq: "hello world",
    withNewline: "line one\nline two",
    withQuote: 'she said "hi"',
    withTab: "a\tb",
    withBackslash: "a\\b",
    sq: "it's fine",
    sqNoEscape: "a\\nb",
    numberish: "42",
    boolish: "true",
    empty: "",
    hashInside: "a # b",
    trailing: "kept",
  });
});

NodeTest.test("comments: full-line, trailing, and comment-as-value", () => {
  const parsed = parseYaml(
    [
      "# leading",
      "a: 1 # trailing",
      "  # indented full-line comment",
      "b: two#notacomment",
      "c: # only a comment here",
      "  d: 4",
      "list:",
      "  - one # trailing on an item",
      "  # a comment between items",
      "  - two",
    ].join("\n"),
  );
  NodeAssert.deepEqual(parsed, {
    a: 1,
    b: "two#notacomment",
    c: { d: 4 },
    list: ["one", "two"],
  });
});

NodeTest.test("empty containers survive the round-trip as themselves", () => {
  NodeAssert.deepEqual(parseYaml("a: {}\nb: []\n"), { a: {}, b: [] });
  NodeAssert.deepEqual(parseYaml("a: { }\nb: [ ]\n"), { a: {}, b: [] });
  NodeAssert.equal(stringifyYaml({ a: {}, b: [] }), "a: {}\nb: []\n");
  roundTrip({ a: {}, b: [], c: { d: [] } });
});

NodeTest.test("a key with no value and no block is null", () => {
  NodeAssert.deepEqual(parseYaml("a:\nb: 1\n"), { a: null, b: 1 });
});

NodeTest.test("sequences may be written flush with their key or indented", () => {
  const flush = parseYaml(["identities:", "- one", "- two", "next: 1"].join("\n"));
  const indented = parseYaml(["identities:", "  - one", "  - two", "next: 1"].join("\n"));
  NodeAssert.deepEqual(flush, { identities: ["one", "two"], next: 1 });
  NodeAssert.deepEqual(flush, indented);
  // Output is always canonical (indented), whichever form came in.
  NodeAssert.equal(stringifyYaml(flush), "identities:\n  - one\n  - two\nnext: 1\n");
});

NodeTest.test("deeply nested maps", () => {
  const parsed = parseYaml(["a:", "  b:", "    c:", "      d: deep", "e: shallow"].join("\n"));
  NodeAssert.deepEqual(parsed, { a: { b: { c: { d: "deep" } } }, e: "shallow" });
});

NodeTest.test("keys may contain spaces, and quoted keys are supported", () => {
  const parsed = parseYaml(["Some Client Name: a client", '"weird: key": value'].join("\n"));
  NodeAssert.deepEqual(parsed, { "Some Client Name": "a client", "weird: key": "value" });
});

NodeTest.test("a __proto__ key stays an ordinary own property", () => {
  const parsed = parseYaml("__proto__: polluted\nother: 1\n");
  NodeAssert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  NodeAssert.equal(Object.hasOwn(parsed, "__proto__"), true);
  NodeAssert.equal({}.polluted, undefined);
  NodeAssert.equal(roundTrip(parsed).startsWith("__proto__: polluted"), true);
});

NodeTest.test("rejects tabs for indentation, naming the line", () => {
  const error = parseError("a:\n\tb: 1\n");
  NodeAssert.equal(error.line, 2);
  NodeAssert.match(error.message, /^line 2: tabs are not allowed/u);
  NodeAssert.equal(error.snippet, "\tb: 1");
});

NodeTest.test("rejects odd indentation", () => {
  const error = parseError("a:\n   b: 1\n");
  NodeAssert.equal(error.line, 2);
  NodeAssert.match(error.message, /multiple of two spaces/u);
});

NodeTest.test("rejects an indentation jump of more than one level", () => {
  const error = parseError("a:\n    b: 1\n");
  NodeAssert.equal(error.line, 2);
  NodeAssert.match(error.message, /exactly two spaces/u);
});

NodeTest.test("rejects anchors and aliases", () => {
  NodeAssert.match(parseError("a: &anchor 1\n").message, /anchors and aliases/u);
  const alias = parseError("a: 1\nb: *anchor\n");
  NodeAssert.equal(alias.line, 2);
  NodeAssert.match(alias.message, /anchors and aliases/u);
});

NodeTest.test("rejects non-empty flow collections", () => {
  NodeAssert.match(parseError("a: {b: 1}\n").message, /flow collections/u);
  const seq = parseError("a: 1\nb: [1, 2]\n");
  NodeAssert.equal(seq.line, 2);
  NodeAssert.match(seq.message, /flow collections/u);
});

NodeTest.test("rejects multiline scalars", () => {
  NodeAssert.match(parseError("a: |\n  text\n").message, /multiline scalars/u);
  NodeAssert.match(parseError("a: >-\n  text\n").message, /multiline scalars/u);
});

NodeTest.test("rejects sequences whose items are maps", () => {
  const inline = parseError("projects:\n  - key: value\n");
  NodeAssert.equal(inline.line, 2);
  NodeAssert.match(inline.message, /must be scalars/u);

  const nested = parseError("projects:\n  -\n    key: value\n");
  NodeAssert.match(nested.message, /must be scalars/u);
});

NodeTest.test("rejects duplicate keys in the same map", () => {
  const error = parseError("a: 1\nb: 2\na: 3\n");
  NodeAssert.equal(error.line, 3);
  NodeAssert.match(error.message, /duplicate key "a"/u);
  // The same key at different depths is fine.
  NodeAssert.deepEqual(parseYaml("a: 1\nb:\n  a: 2\n"), { a: 1, b: { a: 2 } });
});

NodeTest.test("rejects a document that is not a map at the root", () => {
  NodeAssert.match(parseError("- one\n- two\n").message, /root must be a map/u);
  NodeAssert.match(parseError("just a scalar\n").message, /expected a 'key: value' entry/u);
  NodeAssert.match(parseError("  a: 1\n").message, /must start at column 0/u);
});

NodeTest.test("rejects malformed quoting", () => {
  NodeAssert.match(parseError('a: "unterminated\n').message, /unterminated quoted scalar/u);
  NodeAssert.match(parseError('a: "bad \\q escape"\n').message, /unsupported escape sequence/u);
  NodeAssert.match(
    parseError('a: "quoted" trailing\n').message,
    /unexpected text after a quoted scalar/u,
  );
});

NodeTest.test("rejects a non-string input", () => {
  NodeAssert.throws(() => parseYaml(null), YamlLiteError);
  NodeAssert.throws(() => parseYaml({ a: 1 }), YamlLiteError);
});

NodeTest.test("the writer quotes everything that would otherwise change meaning", () => {
  const value = {
    emptyString: "",
    leadingSpace: " x",
    trailingSpace: "x ",
    colonSpace: "key: value",
    endsWithColon: "note:",
    leadingHash: "#1",
    leadingDash: "-1x",
    spacedHash: "a # b",
    numeric: "42",
    floaty: "1.5",
    boolean: "true",
    nullish: "null",
    tilde: "~",
    star: "*.md",
    amp: "&ref",
    brace: "{}",
    bracket: "[]",
    pipe: "|",
    newline: "a\nb",
    tab: "a\tb",
    quote: 'say "hi"',
    apostrophe: "it's",
  };
  const text = roundTrip(value);
  // Everything above must survive as a string, not as the type it resembles.
  for (const parsed of Object.values(parseYaml(text))) {
    NodeAssert.equal(typeof parsed, "string");
  }
  // An apostrophe alone does not need quoting; a leading one would.
  NodeAssert.match(text, /apostrophe: it's/u);
});

NodeTest.test("control characters are \\u-escaped rather than emitted raw", () => {
  const bell = "a\u0007b";
  const text = stringifyYaml({ note: bell });
  NodeAssert.equal(text, 'note: "a\\u0007b"\n');
  NodeAssert.deepEqual(parseYaml(text), { note: bell });
  NodeAssert.match(parseError('a: "bad \\u00zz escape"').message, /four hex digits/u);
});

NodeTest.test("round-trips every supported shape", () => {
  roundTrip({});
  roundTrip({ a: 1, b: "two", c: true, d: null, e: 1.25, f: -3 });
  roundTrip({ list: ["a", "b", "c"], mixed: [1, true, null, "x"] });
  roundTrip({ nested: { deeper: { deepest: { value: "x", list: ["y"] } } } });
  roundTrip({
    version: 1,
    identities: ["Raj D", "raj@example.com"],
    defaults: { active_gap_minutes: 30, single_event_minutes: 1 },
    projects: {
      t3code: {
        display_name: "T3 Code (fork)",
        roots: ["/tmp/t3code", "/tmp/t3code-work"],
        include: true,
        visibility: "public",
        confirmed: true,
        link: "https://github.com/radroid/t3code",
        blurb: "My fork of the T3 Code agent IDE",
      },
      "client-x": {
        display_name: "Client X",
        include: true,
        visibility: "generic",
        confirmed: false,
      },
    },
  });
});

NodeTest.test("output preserves key insertion order", () => {
  const text = stringifyYaml({ zebra: 1, apple: 2, mango: { pear: 3, kiwi: 4 } });
  NodeAssert.equal(text, "zebra: 1\napple: 2\nmango:\n  pear: 3\n  kiwi: 4\n");
  NodeAssert.deepEqual(Object.keys(parseYaml(text)), ["zebra", "apple", "mango"]);
});

NodeTest.test("comments are emitted above the addressed key, at its indent", () => {
  const text = stringifyYaml(
    { version: 1, defaults: { gap: 30 }, projects: { t3code: { include: true } } },
    {
      comments: {
        version: "Schema version.",
        defaults: "Tuning knobs.\nTwo lines, both commented.",
        "defaults.gap": "# already hashed",
        "projects.t3code": "One entry per project.",
      },
    },
  );
  NodeAssert.equal(
    text,
    [
      "# Schema version.",
      "version: 1",
      "# Tuning knobs.",
      "# Two lines, both commented.",
      "defaults:",
      "  # already hashed",
      "  gap: 30",
      "projects:",
      "  # One entry per project.",
      "  t3code:",
      "    include: true",
      "",
    ].join("\n"),
  );
  NodeAssert.deepEqual(parseYaml(text), {
    version: 1,
    defaults: { gap: 30 },
    projects: { t3code: { include: true } },
  });
});

NodeTest.test("the writer skips undefined values", () => {
  NodeAssert.equal(stringifyYaml({ a: 1, b: undefined, c: 3 }), "a: 1\nc: 3\n");
  NodeAssert.equal(stringifyYaml({ a: { b: undefined } }), "a: {}\n");
});

NodeTest.test("the writer refuses what it cannot represent", () => {
  NodeAssert.throws(() => stringifyYaml(null), YamlLiteError);
  NodeAssert.throws(() => stringifyYaml([1, 2]), YamlLiteError);
  NodeAssert.throws(() => stringifyYaml("scalar"), YamlLiteError);
  NodeAssert.throws(() => stringifyYaml({ a: [{ b: 1 }] }), /sequence items must be scalars/u);
  NodeAssert.throws(() => stringifyYaml({ a: [[1]] }), /sequence items must be scalars/u);
  NodeAssert.throws(
    () => stringifyYaml({ a: Number.POSITIVE_INFINITY }),
    /cannot represent the number/u,
  );
  NodeAssert.throws(() => stringifyYaml({ a: Number.NaN }), /cannot represent the number/u);
  NodeAssert.throws(() => stringifyYaml({ a: 1n }), /cannot represent a value of type bigint/u);
  NodeAssert.throws(
    () => stringifyYaml({ a: new Date() }),
    /cannot represent a value of type object/u,
  );

  const cycle = { a: {} };
  cycle.a.self = cycle;
  NodeAssert.throws(() => stringifyYaml(cycle), /circular reference/u);
});

NodeTest.test("YamlLiteError carries a line and a snippet", () => {
  const error = parseError("ok: 1\nbad: [1]\n");
  NodeAssert.ok(error instanceof Error);
  NodeAssert.equal(error.name, "YamlLiteError");
  NodeAssert.equal(error.line, 2);
  NodeAssert.equal(error.snippet, "bad: [1]");
});
