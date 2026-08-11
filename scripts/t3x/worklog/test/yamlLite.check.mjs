import assert from "node:assert/strict";
import test from "node:test";

import { parseYaml, stringifyYaml, YamlLiteError } from "../lib/yamlLite.mjs";

/** Asserts that `text` fails to parse, and returns the error so the caller can inspect it. */
function parseError(text) {
  try {
    parseYaml(text);
  } catch (error) {
    assert.ok(error instanceof YamlLiteError, `expected a YamlLiteError, got ${error}`);
    return error;
  }
  return assert.fail(`expected a YamlLiteError for:\n${text}`);
}

/** Asserts the round-trip invariant: parse(stringify(x)) deep-equals x. */
function roundTrip(value, options) {
  const text = stringifyYaml(value, options);
  assert.deepEqual(parseYaml(text), value, `round-trip failed for:\n${text}`);
  return text;
}

test("parses the registry shape from the design doc", () => {
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

  assert.deepEqual(parseYaml(text), {
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

test("an empty or comment-only document is an empty map", () => {
  assert.deepEqual(parseYaml(""), {});
  assert.deepEqual(parseYaml("\n\n   \n"), {});
  assert.deepEqual(parseYaml("# just a note\n#and another\n"), {});
});

test("scalar types", () => {
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
  assert.deepEqual(parsed, {
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

test("quoted scalars and their escapes", () => {
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
  assert.deepEqual(parsed, {
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

test("comments: full-line, trailing, and comment-as-value", () => {
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
  assert.deepEqual(parsed, {
    a: 1,
    b: "two#notacomment",
    c: { d: 4 },
    list: ["one", "two"],
  });
});

test("empty containers survive the round-trip as themselves", () => {
  assert.deepEqual(parseYaml("a: {}\nb: []\n"), { a: {}, b: [] });
  assert.deepEqual(parseYaml("a: { }\nb: [ ]\n"), { a: {}, b: [] });
  assert.equal(stringifyYaml({ a: {}, b: [] }), "a: {}\nb: []\n");
  roundTrip({ a: {}, b: [], c: { d: [] } });
});

test("a key with no value and no block is null", () => {
  assert.deepEqual(parseYaml("a:\nb: 1\n"), { a: null, b: 1 });
});

test("sequences may be written flush with their key or indented", () => {
  const flush = parseYaml(["identities:", "- one", "- two", "next: 1"].join("\n"));
  const indented = parseYaml(["identities:", "  - one", "  - two", "next: 1"].join("\n"));
  assert.deepEqual(flush, { identities: ["one", "two"], next: 1 });
  assert.deepEqual(flush, indented);
  // Output is always canonical (indented), whichever form came in.
  assert.equal(stringifyYaml(flush), "identities:\n  - one\n  - two\nnext: 1\n");
});

test("deeply nested maps", () => {
  const parsed = parseYaml(["a:", "  b:", "    c:", "      d: deep", "e: shallow"].join("\n"));
  assert.deepEqual(parsed, { a: { b: { c: { d: "deep" } } }, e: "shallow" });
});

test("keys may contain spaces, and quoted keys are supported", () => {
  const parsed = parseYaml(["Some Client Name: a client", '"weird: key": value'].join("\n"));
  assert.deepEqual(parsed, { "Some Client Name": "a client", "weird: key": "value" });
});

test("a __proto__ key stays an ordinary own property", () => {
  const parsed = parseYaml("__proto__: polluted\nother: 1\n");
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.hasOwn(parsed, "__proto__"), true);
  assert.equal({}.polluted, undefined);
  assert.equal(roundTrip(parsed).startsWith("__proto__: polluted"), true);
});

test("rejects tabs for indentation, naming the line", () => {
  const error = parseError("a:\n\tb: 1\n");
  assert.equal(error.line, 2);
  assert.match(error.message, /^line 2: tabs are not allowed/u);
  assert.equal(error.snippet, "\tb: 1");
});

test("rejects odd indentation", () => {
  const error = parseError("a:\n   b: 1\n");
  assert.equal(error.line, 2);
  assert.match(error.message, /multiple of two spaces/u);
});

test("rejects an indentation jump of more than one level", () => {
  const error = parseError("a:\n    b: 1\n");
  assert.equal(error.line, 2);
  assert.match(error.message, /exactly two spaces/u);
});

test("rejects anchors and aliases", () => {
  assert.match(parseError("a: &anchor 1\n").message, /anchors and aliases/u);
  const alias = parseError("a: 1\nb: *anchor\n");
  assert.equal(alias.line, 2);
  assert.match(alias.message, /anchors and aliases/u);
});

test("rejects non-empty flow collections", () => {
  assert.match(parseError("a: {b: 1}\n").message, /flow collections/u);
  const seq = parseError("a: 1\nb: [1, 2]\n");
  assert.equal(seq.line, 2);
  assert.match(seq.message, /flow collections/u);
});

test("rejects multiline scalars", () => {
  assert.match(parseError("a: |\n  text\n").message, /multiline scalars/u);
  assert.match(parseError("a: >-\n  text\n").message, /multiline scalars/u);
});

test("rejects sequences whose items are maps", () => {
  const inline = parseError("projects:\n  - key: value\n");
  assert.equal(inline.line, 2);
  assert.match(inline.message, /must be scalars/u);

  const nested = parseError("projects:\n  -\n    key: value\n");
  assert.match(nested.message, /must be scalars/u);
});

test("rejects duplicate keys in the same map", () => {
  const error = parseError("a: 1\nb: 2\na: 3\n");
  assert.equal(error.line, 3);
  assert.match(error.message, /duplicate key "a"/u);
  // The same key at different depths is fine.
  assert.deepEqual(parseYaml("a: 1\nb:\n  a: 2\n"), { a: 1, b: { a: 2 } });
});

test("rejects a document that is not a map at the root", () => {
  assert.match(parseError("- one\n- two\n").message, /root must be a map/u);
  assert.match(parseError("just a scalar\n").message, /expected a 'key: value' entry/u);
  assert.match(parseError("  a: 1\n").message, /must start at column 0/u);
});

test("rejects malformed quoting", () => {
  assert.match(parseError('a: "unterminated\n').message, /unterminated quoted scalar/u);
  assert.match(parseError('a: "bad \\q escape"\n').message, /unsupported escape sequence/u);
  assert.match(
    parseError('a: "quoted" trailing\n').message,
    /unexpected text after a quoted scalar/u,
  );
});

test("rejects a non-string input", () => {
  assert.throws(() => parseYaml(null), YamlLiteError);
  assert.throws(() => parseYaml({ a: 1 }), YamlLiteError);
});

test("the writer quotes everything that would otherwise change meaning", () => {
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
    assert.equal(typeof parsed, "string");
  }
  // An apostrophe alone does not need quoting; a leading one would.
  assert.match(text, /apostrophe: it's/u);
});

test("control characters are \\u-escaped rather than emitted raw", () => {
  const bell = "a\u0007b";
  const text = stringifyYaml({ note: bell });
  assert.equal(text, 'note: "a\\u0007b"\n');
  assert.deepEqual(parseYaml(text), { note: bell });
  assert.match(parseError('a: "bad \\u00zz escape"').message, /four hex digits/u);
});

test("round-trips every supported shape", () => {
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

test("output preserves key insertion order", () => {
  const text = stringifyYaml({ zebra: 1, apple: 2, mango: { pear: 3, kiwi: 4 } });
  assert.equal(text, "zebra: 1\napple: 2\nmango:\n  pear: 3\n  kiwi: 4\n");
  assert.deepEqual(Object.keys(parseYaml(text)), ["zebra", "apple", "mango"]);
});

test("comments are emitted above the addressed key, at its indent", () => {
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
  assert.equal(
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
  assert.deepEqual(parseYaml(text), {
    version: 1,
    defaults: { gap: 30 },
    projects: { t3code: { include: true } },
  });
});

test("the writer skips undefined values", () => {
  assert.equal(stringifyYaml({ a: 1, b: undefined, c: 3 }), "a: 1\nc: 3\n");
  assert.equal(stringifyYaml({ a: { b: undefined } }), "a: {}\n");
});

test("the writer refuses what it cannot represent", () => {
  assert.throws(() => stringifyYaml(null), YamlLiteError);
  assert.throws(() => stringifyYaml([1, 2]), YamlLiteError);
  assert.throws(() => stringifyYaml("scalar"), YamlLiteError);
  assert.throws(() => stringifyYaml({ a: [{ b: 1 }] }), /sequence items must be scalars/u);
  assert.throws(() => stringifyYaml({ a: [[1]] }), /sequence items must be scalars/u);
  assert.throws(
    () => stringifyYaml({ a: Number.POSITIVE_INFINITY }),
    /cannot represent the number/u,
  );
  assert.throws(() => stringifyYaml({ a: Number.NaN }), /cannot represent the number/u);
  assert.throws(() => stringifyYaml({ a: 1n }), /cannot represent a value of type bigint/u);
  assert.throws(() => stringifyYaml({ a: new Date() }), /cannot represent a value of type object/u);

  const cycle = { a: {} };
  cycle.a.self = cycle;
  assert.throws(() => stringifyYaml(cycle), /circular reference/u);
});

test("YamlLiteError carries a line and a snippet", () => {
  const error = parseError("ok: 1\nbad: [1]\n");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "YamlLiteError");
  assert.equal(error.line, 2);
  assert.equal(error.snippet, "bad: [1]");
});
