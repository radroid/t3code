/*
 * First-run install instructions for the download page.
 *
 * The data is NOT defined here. It lives in scripts/coil/install-instructions.json, which the
 * release workflow also renders into every GitHub release body via
 * scripts/coil/render-release-notes.mjs. Two surfaces, one source — before issue #72 the release
 * body was the only copy, and this page merely said the release notes "carry the commands to get
 * past it" without linking them, so a reader could arrive here, download a build, and meet a
 * Gatekeeper dialog calling it damaged with nothing on screen to explain it.
 *
 * The JSON is imported rather than fetched, on purpose: these steps have to be on the page when
 * it renders, including when the update relay is down and there is nothing else to show. The
 * types come from the import — hand-written interfaces here would be a third copy of the shape.
 */
import instructions from "../../../../scripts/coil/install-instructions.json";

export const APP_BUNDLE_NAME = instructions.appBundleName;
export const UNSIGNED_NOTE = instructions.unsignedNote;
export const INSTALL_PLATFORMS = instructions.platforms;

export type InstallPlatform = (typeof INSTALL_PLATFORMS)[number];

/**
 * Fills a command template for display. `{file}` is the asset the reader is about to download,
 * so the page renders the example name and the client script swaps in the real one once the
 * manifest arrives. Passing `"{file}"` back in leaves the placeholder intact, which is how the
 * template is handed to the browser.
 */
export function fillCommand(template: string, file: string): string {
  return template.replace(/\{app\}/gu, APP_BUNDLE_NAME).replace(/\{file\}/gu, file);
}

/**
 * Marks up the small amount of `**bold**` the instruction copy uses, and nothing else. The text
 * is ours rather than user input, but it is interpolated with `set:html`, so it is escaped first
 * — the alternative is a rule that only holds until someone pastes a Gatekeeper message
 * containing a `<` into the JSON.
 */
export function renderEmphasis(text: string): string {
  const escaped = text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  return escaped.replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>");
}
