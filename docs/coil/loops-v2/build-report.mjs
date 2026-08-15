#!/usr/bin/env node
/**
 * Builds report.html from report.src.html by inlining each prototype into an
 * <iframe srcdoc>.
 *
 * Why srcdoc rather than src: the report has to open from a plain file:// path
 * with no server. A same-directory iframe src works in some browsers and is
 * blocked in others; srcdoc always renders, and it makes report.html a single
 * self-contained artifact that survives being emailed or moved.
 *
 * Marker format:
 *   <!--EMBED:file.html|height|tag|name|hint-->
 *
 * Run: node docs/coil/loops-v2/build-report.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const protoDir = join(here, "prototypes");

const shellCss = readFileSync(join(protoDir, "_shell.css"), "utf8");

/** Inline the shared stylesheet so the iframe needs no network or file access. */
function inlineCss(html) {
  const linkRe = /<link rel="stylesheet" href="_shell\.css"\s*\/?>/;
  if (!linkRe.test(html)) {
    throw new Error("prototype is missing the _shell.css link — refusing to emit a broken frame");
  }
  return html.replace(linkRe, `<style>\n${shellCss}\n</style>`);
}

/**
 * Escape for an HTML double-quoted attribute. Order matters: & first, or the
 * entities produced below get double-escaped.
 */
function forSrcdoc(html) {
  return html
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const src = readFileSync(join(here, "report.src.html"), "utf8");

let embedded = 0;
const out = src.replace(/<!--EMBED:([^|]+)\|(\d+)\|([^|]*)\|([^|]*)\|([^>]*?)-->/g, (_m, file, height, tag, name, hint) => {
  const raw = readFileSync(join(protoDir, file.trim()), "utf8");
  const doc = forSrcdoc(inlineCss(raw));
  embedded += 1;
  return `<div class="proto">
        <div class="proto-bar">
          <span class="proto-tag">${tag}</span>
          <span class="proto-name">${name}</span>
          <span class="proto-hint">${hint}</span>
          <a class="proto-open" href="prototypes/${file.trim()}" target="_blank" rel="noopener">Open standalone ↗</a>
        </div>
        <iframe title="${name}" height="${height}" loading="lazy" srcdoc="${doc}"></iframe>
      </div>`;
});

if (embedded === 0) throw new Error("no EMBED markers matched — the marker syntax has drifted");

writeFileSync(join(here, "report.html"), out);

const kb = (Buffer.byteLength(out) / 1024).toFixed(0);
console.log(`report.html written — ${embedded} prototypes inlined, ${kb} KB`);
