import type { DesktopAppBranding } from "@t3tools/contracts";
import { formatAppDisplayName } from "./branding.logic";

function readInjectedDesktopAppBranding(): DesktopAppBranding | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.desktopBridge?.getAppBranding?.() ?? null;
}

const injectedDesktopAppBranding = readInjectedDesktopAppBranding();
const hostedAppChannel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();

export const HOSTED_APP_CHANNEL =
  hostedAppChannel === "latest" || hostedAppChannel === "nightly" ? hostedAppChannel : null;
export const HOSTED_APP_CHANNEL_LABEL =
  HOSTED_APP_CHANNEL === "nightly" ? "Nightly" : HOSTED_APP_CHANNEL === "latest" ? "Latest" : null;
export const APP_BASE_NAME = injectedDesktopAppBranding?.baseName ?? "T3 Coil";
export const APP_STAGE_LABEL =
  injectedDesktopAppBranding?.stageLabel ??
  HOSTED_APP_CHANNEL_LABEL ??
  (import.meta.env.DEV ? "Dev" : "Alpha");
export const APP_DISPLAY_NAME =
  injectedDesktopAppBranding?.displayName ??
  formatAppDisplayName({ baseName: APP_BASE_NAME, stageLabel: APP_STAGE_LABEL });
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";

/**
 * coil: the word the sidebar renders beside the shared `T3` glyph.
 *
 * Derived rather than written out a second time. `scripts/coil/install-instructions.json` records
 * what a cached copy of this name costs — it needed a test to keep it honest — and the sidebar is
 * the same class of duplication, one that would sit in an upstream-owned file where a stale literal
 * is hardest to notice. So it reads the base name instead of repeating it, and a build whose
 * desktop bundle injects a different `baseName` renames the sidebar with it.
 *
 * The prefix is stripped because the glyph already draws `T3`. If a future name drops that prefix,
 * the replace is a no-op and the whole base name is what belongs beside the mark anyway.
 */
export const APP_WORDMARK_SUFFIX = APP_BASE_NAME.replace(/^T3\s+/u, "");
