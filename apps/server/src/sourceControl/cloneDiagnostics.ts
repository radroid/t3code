import type { SourceControlProviderInfo } from "@t3tools/contracts";

import { transportSafeSourceControlErrorValue } from "./SourceControlProvider.ts";

/**
 * Environment for git commands the user has no console or window to answer.
 *
 * A credential helper (Git Credential Manager, ssh-askpass) that decides to
 * prompt blocks the subprocess until its timeout, because the server spawning
 * it has nowhere to draw the prompt — and on a remote or headless server the
 * user could not answer it anyway. Refusing the prompt turns that hang into a
 * non-zero exit `classifyGitCloneFailure` can name.
 *
 * `GitVcsDriverCore` applies the same set to background status refreshes under
 * its own private constant; upstreaming this module should collapse the two.
 */
export const NON_INTERACTIVE_GIT_ENV = Object.freeze({
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
} satisfies NodeJS.ProcessEnv);

export type GitCloneFailureKind =
  | "authentication"
  | "host-key"
  | "not-found"
  | "network"
  | "unknown";

const HOST_KEY_MARKERS = [
  "host key verification failed",
  "no matching host key",
  "remote host identification has changed",
];

const AUTHENTICATION_MARKERS = [
  "authentication failed",
  "authentication is required",
  "could not read username",
  "could not read password",
  "terminal prompts disabled",
  "permission denied (publickey",
  "invalid credentials",
  "unauthorized",
  "access denied",
  "returned error: 401",
  "returned error: 403",
];

const NOT_FOUND_MARKERS = [
  "repository not found",
  "not found",
  "does not exist",
  "returned error: 404",
];

const NETWORK_MARKERS = [
  "could not resolve host",
  "could not resolve proxy",
  "failed to connect",
  "connection refused",
  "connection timed out",
  "operation timed out",
  "network is unreachable",
  "ssl certificate problem",
];

const includesAny = (haystack: string, markers: ReadonlyArray<string>): boolean =>
  markers.some((marker) => haystack.includes(marker));

/**
 * Names what stopped a `git clone`, from the stderr git produced. Deliberately
 * ordered: an unverified host key reads as a permission failure but no
 * credential fixes it, and an unreachable host reads as a missing repository.
 */
export function classifyGitCloneFailure(stderr: string): GitCloneFailureKind {
  const normalized = stderr.toLowerCase();

  if (includesAny(normalized, HOST_KEY_MARKERS)) {
    return "host-key";
  }
  if (includesAny(normalized, AUTHENTICATION_MARKERS)) {
    return "authentication";
  }
  if (includesAny(normalized, NOT_FOUND_MARKERS)) {
    return "not-found";
  }
  if (includesAny(normalized, NETWORK_MARKERS)) {
    return "network";
  }
  return "unknown";
}

const MAX_DIAGNOSTIC_LENGTH = 200;

// Scheme-relative match that stops at the quotes git wraps remote URLs in, so
// the credentials inside one are redacted without swallowing the punctuation
// around it.
const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/giu;

function sanitizeLine(line: string): string {
  let printable = "";
  for (const character of line) {
    const codePoint = character.codePointAt(0);
    printable += codePoint !== undefined && (codePoint < 32 || codePoint === 127) ? " " : character;
  }

  return printable
    .replace(URL_PATTERN, (match) => transportSafeSourceControlErrorValue(match))
    .replace(/\s+/gu, " ")
    .trim();
}

function findLastMatch(lines: ReadonlyArray<string>, pattern: RegExp): string | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line !== undefined && pattern.test(line)) {
      return line;
    }
  }
  return undefined;
}

/**
 * Reduces git's output to the one line worth showing a user, with any
 * credentials embedded in a remote URL removed. Only ever the failing line:
 * git names the cause on `fatal:`/`error:`, and the lines above it are progress
 * chatter that would push the real message out of a toast.
 */
export function redactGitOutput(output: string): string {
  const lines = output
    .split(/\r?\n/u)
    .map(sanitizeLine)
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return "";
  }

  const failing =
    findLastMatch(lines, /^(?:fatal|error):/iu) ??
    findLastMatch(lines, /^remote:/iu) ??
    lines[lines.length - 1];

  return (failing ?? "").slice(0, MAX_DIAGNOSTIC_LENGTH);
}

const ON_SERVER = "the machine running T3 Code";

function credentialHint(provider: SourceControlProviderInfo | null): string {
  switch (provider?.kind) {
    case "bitbucket":
      return `Bitbucket needs an app password or repository access token in git's credential helper on ${ON_SERVER} — the T3CODE_BITBUCKET_* variables only authenticate Bitbucket's API, not git.`;
    case "github":
      return `Run "gh auth login" then "gh auth setup-git" on ${ON_SERVER}, or clone over SSH with a key it can use.`;
    case "gitlab":
      return `Run "glab auth login" on ${ON_SERVER}, or clone over SSH with a key it can use.`;
    case "azure-devops":
      return `Azure DevOps needs a personal access token in git's credential helper on ${ON_SERVER}.`;
    default:
      return `Store its credentials in git's credential helper on ${ON_SERVER} — cloning once from a terminal there will prompt and remember them.`;
  }
}

/**
 * Turns a failed clone into a sentence that names the cause and the next step.
 * Falls back to git's own failing line rather than a constant, so a failure
 * this module has not learned to classify is still reportable.
 */
export function describeGitCloneFailure(input: {
  readonly stderr: string;
  readonly provider: SourceControlProviderInfo | null;
}): string {
  const host = input.provider?.name ?? "the remote";

  switch (classifyGitCloneFailure(input.stderr)) {
    case "host-key":
      return `Git could not verify the SSH host key for ${host}. Connect to it once from a terminal on ${ON_SERVER} to record the key, then clone again.`;
    case "authentication":
      return `Git could not authenticate to ${host}. ${credentialHint(input.provider)}`;
    case "not-found":
      return `No repository was found at ${host} for that URL. A private repository that ${ON_SERVER} cannot authenticate to also reports as missing.`;
    case "network":
      return `Git could not reach ${host}. Check the URL and the network on ${ON_SERVER}.`;
    case "unknown": {
      const detail = redactGitOutput(input.stderr);
      return detail.length > 0
        ? `Git could not clone from ${host}: ${detail}`
        : `Git could not clone from ${host}, and produced no output explaining why.`;
    }
  }
}
