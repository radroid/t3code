// A deliberately small, strict YAML subset — enough for the two `/worklog` config files and
// nothing more.
//
// The point is not to be a YAML implementation. It is to be a *round-trippable* one with zero
// dependencies: `parseYaml(stringifyYaml(x))` deep-equals `x` for every shape we support, so a
// config file a human edits and a config file the tool rewrites converge on the same text. Every
// feature outside that guarantee (anchors, flow collections, multiline scalars, sequences of maps)
// is rejected by name and by line number rather than half-implemented, because a YAML file that
// silently parses to something other than what it looks like is worse than one that fails loudly.
//
// The one deliberate extension beyond "block YAML only": the empty flow tokens `{}` and `[]` are
// accepted, because they are the only way to write an empty map or an empty sequence and still
// tell the two apart on the way back in. Non-empty flow collections stay rejected.

// Bare scalars starting with any of these are ambiguous with YAML syntax we either reject or use
// structurally, so the writer always quotes them.
const AMBIGUOUS_FIRST_CHARS = new Set([
  "#",
  "-",
  "?",
  ":",
  ",",
  "[",
  "]",
  "{",
  "}",
  "&",
  "*",
  "!",
  "|",
  ">",
  "'",
  '"',
  "%",
  "@",
  "`",
]);

const DOUBLE_QUOTE_ESCAPES = new Map([
  ["\\", "\\"],
  ['"', '"'],
  ["n", "\n"],
  ["t", "\t"],
  ["r", "\r"],
  ["/", "/"],
]);

const DOUBLE_QUOTE_ENCODES = new Map([
  ["\\", "\\\\"],
  ['"', '\\"'],
  ["\n", "\\n"],
  ["\t", "\\t"],
  ["\r", "\\r"],
]);

// C0 controls plus DEL. Valid YAML forbids these in a plain scalar, so the writer quotes and
// `\u`-escapes them rather than emitting a file no other reader would accept.
// oxlint-disable-next-line eslint/no-control-regex -- matching them is the whole point.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

/** Parse/serialise failure that names the offending line (1-based) and carries its raw text. */
export class YamlLiteError extends Error {
  constructor(message, { line = null, snippet = "" } = {}) {
    super(typeof line === "number" ? `line ${line}: ${message}` : message);
    this.name = "YamlLiteError";
    this.line = typeof line === "number" ? line : null;
    this.snippet = snippet;
  }
}

/** Parses the supported YAML subset into a plain object; throws `YamlLiteError` on anything else. */
export function parseYaml(text) {
  if (typeof text !== "string") {
    throw new YamlLiteError("expected a string to parse", { snippet: String(text) });
  }
  const lines = scanLines(text);
  if (lines.length === 0) return {};
  if (lines[0].indent !== 0) {
    fail("the document must start at column 0", lines[0]);
  }
  if (isSequenceItem(lines[0])) {
    fail("the document root must be a map, not a sequence", lines[0]);
  }
  const [value, next] = parseMap(lines, 0, 0);
  if (next < lines.length) fail("unexpected indentation", lines[next]);
  return value;
}

/**
 * Renders a plain object as canonical YAML; `comments` maps a dotted key path to a line emitted
 * above that key.
 */
export function stringifyYaml(value, { comments } = {}) {
  if (!isPlainObject(value)) {
    throw new YamlLiteError("the document root must be a map", { snippet: describe(value) });
  }
  const out = [];
  writeMap(value, 0, "", out, comments ?? {}, new Set());
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

// --- parsing ----------------------------------------------------------------------------------

function scanLines(text) {
  const out = [];
  const raw = text.split(/\r?\n/u);
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i];
    const lineNo = i + 1;
    if (line.trim() === "") continue;

    const leading = /^[ \t]*/u.exec(line)[0];
    if (leading.includes("\t")) {
      throw new YamlLiteError("tabs are not allowed for indentation, use two spaces per level", {
        line: lineNo,
        snippet: line,
      });
    }
    const body = line.slice(leading.length).trimEnd();
    if (body.startsWith("#")) continue;
    if (leading.length % 2 !== 0) {
      throw new YamlLiteError(
        `indentation must be a multiple of two spaces (found ${leading.length})`,
        { line: lineNo, snippet: line },
      );
    }
    out.push({ indent: leading.length, text: body, lineNo, raw: line });
  }
  return out;
}

function parseMap(lines, start, indent) {
  const map = {};
  let i = start;
  while (i < lines.length && lines[i].indent >= indent) {
    const line = lines[i];
    if (line.indent > indent) fail("unexpected indentation", line);
    if (isSequenceItem(line)) fail("expected a 'key: value' entry, found a sequence item", line);

    const { key, rest } = splitKey(line);
    if (Object.hasOwn(map, key)) fail(`duplicate key "${key}" in the same map`, line);

    const inline = stripComment(rest, line);
    if (inline === "") {
      const next = lines[i + 1];
      if (next && next.indent > indent) {
        if (next.indent !== indent + 2) {
          fail("nested blocks indent by exactly two spaces", next);
        }
        const [value, after] = parseBlock(lines, i + 1, indent + 2);
        setKey(map, key, value);
        i = after;
      } else if (next && next.indent === indent && isSequenceItem(next)) {
        // A sequence written flush with its key. Canonical output indents it, but this is the
        // form most people type by hand, so reading it is worth the extra branch.
        const [value, after] = parseSequence(lines, i + 1, indent);
        setKey(map, key, value);
        i = after;
      } else {
        setKey(map, key, null);
        i += 1;
      }
    } else {
      setKey(map, key, parseScalar(inline, line));
      i += 1;
    }
  }
  return [map, i];
}

// Plain assignment would let a `__proto__:` line in a config file reach `Object.prototype`.
// Defining the property keeps it an ordinary own key, so the result stays a boring plain object.
function setKey(map, key, value) {
  Object.defineProperty(map, key, { value, writable: true, enumerable: true, configurable: true });
}

function parseBlock(lines, start, indent) {
  return isSequenceItem(lines[start])
    ? parseSequence(lines, start, indent)
    : parseMap(lines, start, indent);
}

function parseSequence(lines, start, indent) {
  const out = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && isSequenceItem(lines[i])) {
    const line = lines[i];
    const rest = line.text === "-" ? "" : line.text.slice(2).trim();
    const next = lines[i + 1];
    if (next && next.indent > indent) {
      fail(
        "sequence items must be scalars (a nested block inside a sequence is not supported)",
        next,
      );
    }
    const item = stripComment(rest, line);
    if (item !== "" && !isQuote(item[0]) && findKeyColon(item) !== -1) {
      fail("sequence items must be scalars (a map inside a sequence is not supported)", line);
    }
    out.push(item === "" ? null : parseScalar(item, line));
    i += 1;
  }
  return [out, i];
}

function isSequenceItem(line) {
  return line !== undefined && (line.text === "-" || line.text.startsWith("- "));
}

function splitKey(line) {
  const text = line.text;
  if (isQuote(text[0])) {
    const { value, end } = scanQuoted(text, 0, line);
    const after = text.slice(end).trimStart();
    if (!after.startsWith(":")) fail("expected ':' after a quoted key", line);
    return { key: value, rest: after.slice(1).trim() };
  }
  const idx = findKeyColon(text);
  if (idx === -1) fail("expected a 'key: value' entry", line);
  const key = text.slice(0, idx).trimEnd();
  if (key === "") fail("a map key cannot be empty", line);
  return { key, rest: text.slice(idx + 1).trim() };
}

// The first ':' that is followed by a space or ends the line. Anything else (`https://…`, a key
// like `a:b`) is part of the token, which is why this is not a naive `indexOf(":")`.
function findKeyColon(text) {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== ":") continue;
    if (i + 1 === text.length || text[i + 1] === " ") return i;
  }
  return -1;
}

function stripComment(text, line) {
  if (text === "" || text.startsWith("#")) return "";
  if (isQuote(text[0])) {
    const { end } = scanQuoted(text, 0, line);
    const after = text.slice(end).trim();
    if (after !== "" && !after.startsWith("#")) {
      fail("unexpected text after a quoted scalar", line);
    }
    return text.slice(0, end);
  }
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "#" && (i === 0 || /\s/u.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text;
}

function parseScalar(text, line) {
  if (isQuote(text[0])) return scanQuoted(text, 0, line).value;

  const first = text[0];
  if (first === "&" || first === "*") {
    fail("anchors and aliases are not supported", line);
  }
  if (/^[|>][+-]?\d*$/u.test(text)) {
    fail("multiline scalars (| and >) are not supported", line);
  }
  if (first === "{" || first === "[") {
    if (/^\{\s*\}$/u.test(text)) return {};
    if (/^\[\s*\]$/u.test(text)) return [];
    fail("flow collections ({…} and […]) are not supported", line);
  }
  return interpretBare(text);
}

function interpretBare(text) {
  if (text === "" || text === "~" || /^(?:null|Null|NULL)$/u.test(text)) return null;
  if (/^(?:true|True|TRUE)$/u.test(text)) return true;
  if (/^(?:false|False|FALSE)$/u.test(text)) return false;
  if (/^[-+]?\d+$/u.test(text)) {
    const n = Number(text);
    // Outside the safe range the round-trip would silently change the value, so it stays a
    // string — which still round-trips, because the writer leaves it bare.
    return Number.isSafeInteger(n) ? n : text;
  }
  if (/^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/u.test(text) && /[.eE]/u.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) ? n : text;
  }
  return text;
}

function scanQuoted(text, start, line) {
  const quote = text[start];
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (quote === '"') {
      if (ch === "\\") {
        const esc = text[i + 1];
        if (esc === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) fail("a \\u escape needs four hex digits", line);
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 6;
          continue;
        }
        const decoded = esc === undefined ? undefined : DOUBLE_QUOTE_ESCAPES.get(esc);
        if (decoded === undefined) {
          fail(`unsupported escape sequence "\\${esc ?? ""}"`, line);
        }
        out += decoded;
        i += 2;
        continue;
      }
      if (ch === '"') return { value: out, end: i + 1 };
    } else {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        return { value: out, end: i + 1 };
      }
    }
    out += ch;
    i += 1;
  }
  fail("unterminated quoted scalar", line);
}

function isQuote(ch) {
  return ch === '"' || ch === "'";
}

function fail(message, line) {
  throw new YamlLiteError(message, { line: line?.lineNo ?? null, snippet: line?.raw ?? "" });
}

// --- serialising ------------------------------------------------------------------------------

function writeMap(obj, indent, prefix, out, comments, seen) {
  if (seen.has(obj)) {
    throw new YamlLiteError("circular reference", { snippet: prefix });
  }
  seen.add(obj);
  const pad = " ".repeat(indent);
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    const path = prefix === "" ? key : `${prefix}.${key}`;
    writeComment(comments[path], pad, out);
    const label = `${pad}${formatKey(key, path)}:`;

    if (Array.isArray(value)) {
      if (value.length === 0) {
        out.push(`${label} []`);
        continue;
      }
      out.push(label);
      for (const item of value) {
        if (Array.isArray(item) || isPlainObject(item)) {
          throw new YamlLiteError("sequence items must be scalars", { snippet: path });
        }
        out.push(`${pad}  - ${formatScalar(item, path)}`);
      }
      continue;
    }

    if (isPlainObject(value)) {
      if (Object.keys(value).every((k) => value[k] === undefined)) {
        out.push(`${label} {}`);
        continue;
      }
      out.push(label);
      writeMap(value, indent + 2, path, out, comments, seen);
      continue;
    }

    out.push(`${label} ${formatScalar(value, path)}`);
  }
  seen.delete(obj);
}

function writeComment(comment, pad, out) {
  if (typeof comment !== "string" || comment.trim() === "") return;
  for (const raw of comment.split("\n")) {
    const line = raw.trim();
    out.push(line === "" ? `${pad}#` : `${pad}${line.startsWith("#") ? line : `# ${line}`}`);
  }
}

function formatKey(key, path) {
  if (typeof key !== "string")
    throw new YamlLiteError("map keys must be strings", { snippet: path });
  if (key === "" || key !== key.trim()) return quote(key);
  if (AMBIGUOUS_FIRST_CHARS.has(key[0])) return quote(key);
  if (findKeyColon(key) !== -1) return quote(key);
  if (/[#\n\t\r]/u.test(key)) return quote(key);
  return key;
}

function formatScalar(value, path) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new YamlLiteError(`cannot represent the number ${String(value)}`, { snippet: path });
    }
    return String(value);
  }
  if (typeof value !== "string") {
    throw new YamlLiteError(`cannot represent a value of type ${describe(value)}`, {
      snippet: path,
    });
  }
  return needsQuoting(value) ? quote(value) : value;
}

function needsQuoting(s) {
  if (s === "" || s !== s.trim()) return true;
  if (AMBIGUOUS_FIRST_CHARS.has(s[0])) return true;
  if (CONTROL_CHARS.test(s)) return true;
  if (findKeyColon(s) !== -1) return true;
  if (/\s#/u.test(s)) return true;
  // The catch-all: anything that would come back as a number, boolean or null is not the string
  // it looks like, so it has to be quoted.
  return interpretBare(s) !== s;
}

function quote(s) {
  let out = '"';
  for (const ch of s) {
    const encoded = DOUBLE_QUOTE_ENCODES.get(ch);
    if (encoded !== undefined) {
      out += encoded;
      continue;
    }
    if (CONTROL_CHARS.test(ch)) {
      out += `\\u${ch.codePointAt(0).toString(16).padStart(4, "0")}`;
      continue;
    }
    out += ch;
  }
  return `${out}"`;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
