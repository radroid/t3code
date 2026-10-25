/*
 * The data lives in scripts/coil/install-instructions.json, which the release workflow also
 * renders into every release body, so both surfaces share one source. Imported rather than
 * fetched so the steps render even when the update relay is down; types come from the import.
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
