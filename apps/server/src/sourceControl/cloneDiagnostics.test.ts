import { assert, it } from "@effect/vitest";

import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";

import {
  classifyGitCloneFailure,
  describeGitCloneFailure,
  NON_INTERACTIVE_GIT_ENV,
  redactGitOutput,
} from "./cloneDiagnostics.ts";

const describeFor = (remoteUrl: string, stderr: string) =>
  describeGitCloneFailure({
    stderr,
    provider: detectSourceControlProviderFromRemoteUrl(remoteUrl),
  });

it("classifies the credential failures a non-interactive clone produces", () => {
  assert.strictEqual(
    classifyGitCloneFailure(
      "fatal: Authentication failed for 'https://bitbucket.org/ws/repo.git/'",
    ),
    "authentication",
  );
  assert.strictEqual(
    classifyGitCloneFailure(
      "fatal: could not read Username for 'https://bitbucket.org': terminal prompts disabled",
    ),
    "authentication",
  );
  assert.strictEqual(
    classifyGitCloneFailure("git@bitbucket.org: Permission denied (publickey)."),
    "authentication",
  );
  assert.strictEqual(classifyGitCloneFailure("remote: Invalid credentials"), "authentication");
});

it("classifies a missing or inaccessible repository separately from a credential failure", () => {
  assert.strictEqual(classifyGitCloneFailure("remote: Repository not found."), "not-found");
  assert.strictEqual(
    classifyGitCloneFailure("fatal: repository 'https://bitbucket.org/ws/repo.git/' not found"),
    "not-found",
  );
  assert.strictEqual(classifyGitCloneFailure("conq: repository does not exist."), "not-found");
});

it("classifies an unverified SSH host key, which no credential can fix", () => {
  assert.strictEqual(classifyGitCloneFailure("Host key verification failed."), "host-key");
});

it("classifies an unreachable host as a network failure rather than a missing repository", () => {
  assert.strictEqual(
    classifyGitCloneFailure(
      "fatal: unable to access 'https://bitbucket.org/ws/repo.git/': Could not resolve host: bitbucket.org",
    ),
    "network",
  );
  assert.strictEqual(
    classifyGitCloneFailure(
      "fatal: unable to access 'https://bitbucket.org/ws/repo.git/': Failed to connect to bitbucket.org port 443 after 21000 ms",
    ),
    "network",
  );
});

it("leaves output it cannot classify as unknown rather than guessing", () => {
  assert.strictEqual(
    classifyGitCloneFailure("error: RPC failed; curl 92 HTTP/2 stream 0 was not closed cleanly"),
    "unknown",
  );
});

it("keeps the failing line out of multi-line clone output", () => {
  assert.strictEqual(
    redactGitOutput(
      [
        "Cloning into 'repo'...",
        "remote: Invalid credentials",
        "fatal: Authentication failed",
      ].join("\n"),
    ),
    "fatal: Authentication failed",
  );
});

it("removes credentials embedded in a remote URL before the output is surfaced", () => {
  const redacted = redactGitOutput(
    "fatal: unable to access 'https://x-token-auth:ATBBsuper-secret@bitbucket.org/ws/repo.git/': The requested URL returned error: 403",
  );

  assert.notInclude(redacted, "ATBBsuper-secret");
  assert.notInclude(redacted, "x-token-auth");
  assert.include(redacted, "bitbucket.org");
});

it("normalizes control characters and bounds redacted output", () => {
  const redacted = redactGitOutput(`fatal:\tsomething went wrong ${"x".repeat(400)}`);

  assert.isAtMost(redacted.length, 200);
  assert.notInclude(redacted, "\t");
  assert.include(redacted, "fatal: something went wrong");
});

it("names the credential a Bitbucket clone needs, and where it has to live", () => {
  const message = describeFor(
    "https://bitbucket.org/ws/repo.git",
    "fatal: Authentication failed for 'https://bitbucket.org/ws/repo.git/'",
  );

  assert.include(message, "Bitbucket");
  assert.include(message, "app password");
  assert.include(message, "machine running T3 Code");
  assert.notInclude(message, "The source control operation could not be completed.");
});

it("names the credential a GitHub clone needs instead of Bitbucket's", () => {
  const message = describeFor(
    "https://github.com/octocat/t3code.git",
    "fatal: Authentication failed for 'https://github.com/octocat/t3code.git/'",
  );

  assert.include(message, "gh auth login");
  assert.notInclude(message, "app password");
});

it("says a repository was not found without blaming credentials", () => {
  const message = describeFor("https://bitbucket.org/ws/repo.git", "remote: Repository not found.");

  assert.include(message, "Bitbucket");
  assert.notInclude(message, "app password");
});

it("falls back to the redacted git output when the failure cannot be classified", () => {
  const message = describeFor(
    "https://bitbucket.org/ws/repo.git",
    "error: RPC failed; curl 92 HTTP/2 stream 0 was not closed cleanly",
  );

  assert.include(message, "curl 92");
});

it("still names the host when git produced no output at all", () => {
  const message = describeFor("https://bitbucket.org/ws/repo.git", "");

  assert.include(message, "Bitbucket");
  assert.isAbove(message.length, 0);
});

it("disables every interactive credential prompt git can reach for", () => {
  assert.deepStrictEqual(NON_INTERACTIVE_GIT_ENV, {
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "",
    GIT_TERMINAL_PROMPT: "0",
    SSH_ASKPASS: "",
    SSH_ASKPASS_REQUIRE: "never",
  });
});
