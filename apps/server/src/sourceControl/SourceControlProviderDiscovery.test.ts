import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  type VcsError,
  VcsProcessExitError,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as AzureDevOps from "./AzureDevOpsSourceControlProvider.ts";
import { probeSourceControlProvider } from "./SourceControlProviderDiscovery.ts";

const processOutput = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): VcsProcess.VcsProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

interface CapturingProcess {
  readonly process: VcsProcess.VcsProcess["Service"];
  readonly calls: ReadonlyArray<VcsProcess.VcsProcessInput>;
}

const makeProcess = (
  run: (input: VcsProcess.VcsProcessInput) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>,
): CapturingProcess => {
  const calls: VcsProcess.VcsProcessInput[] = [];
  return {
    calls,
    process: {
      run: (input) => {
        calls.push(input);
        return run(input);
      },
    },
  };
};

const isVersionCall = (input: VcsProcess.VcsProcessInput): boolean => input.args[0] === "--version";
const isAuthCall = (input: VcsProcess.VcsProcessInput): boolean => input.args[0] === "account";

it.effect(
  "reports Azure CLI as available and still runs the auth probe when `--version` times out",
  () =>
    Effect.gen(function* () {
      const { process, calls } = makeProcess((input) => {
        if (isVersionCall(input)) {
          return Effect.fail(
            new VcsProcessTimeoutError({
              operation: input.operation,
              command: input.command,
              cwd: input.cwd,
              timeoutMs: input.timeoutMs ?? 0,
            }),
          );
        }
        return Effect.succeed(processOutput("azure-user@example.com\n"));
      });

      const item = yield* probeSourceControlProvider({
        spec: AzureDevOps.discovery,
        process,
        cwd: "/repo",
      });

      assert.strictEqual(item.status, "available");
      assert.strictEqual(item.auth.status, "authenticated");
      assert.deepStrictEqual(item.auth.account, Option.some("azure-user@example.com"));
      assert.ok(
        calls.some(isAuthCall),
        "expected an `account show` auth probe to run after a slow `--version`",
      );
    }),
);

it.effect(
  "reports Azure CLI as missing and skips the auth probe when `--version` cannot spawn",
  () =>
    Effect.gen(function* () {
      const { process, calls } = makeProcess((input) => {
        if (isVersionCall(input)) {
          return Effect.fail(
            new VcsProcessSpawnError({
              operation: input.operation,
              command: input.command,
              cwd: input.cwd,
              cause: Object.assign(new Error("spawn az ENOENT"), { code: "ENOENT" }),
            }),
          );
        }
        return Effect.succeed(processOutput("azure-user@example.com\n"));
      });

      const item = yield* probeSourceControlProvider({
        spec: AzureDevOps.discovery,
        process,
        cwd: "/repo",
      });

      assert.strictEqual(item.status, "missing");
      assert.strictEqual(item.auth.status, "unknown");
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0]?.args[0], "--version");
    }),
);

it.effect(
  "raises the `--version` probe timeout above 15s and reports the version on the happy path",
  () =>
    Effect.gen(function* () {
      const { process, calls } = makeProcess((input) => {
        if (isVersionCall(input)) {
          return Effect.succeed(processOutput("azure-cli 2.87.0\n"));
        }
        return Effect.succeed(processOutput("azure-user@example.com\n"));
      });

      const item = yield* probeSourceControlProvider({
        spec: AzureDevOps.discovery,
        process,
        cwd: "/repo",
      });

      const versionCall = calls.find(isVersionCall);
      assert.ok(versionCall, "expected a `--version` probe to run");
      assert.ok(
        (versionCall.timeoutMs ?? 0) >= 15_000,
        `expected the \`--version\` probe timeout to be >= 15000ms, got ${String(versionCall.timeoutMs)}`,
      );
      assert.deepStrictEqual(item.version, Option.some("azure-cli 2.87.0"));
      assert.strictEqual(item.status, "available");
      assert.strictEqual(item.auth.status, "authenticated");
    }),
);

it.effect(
  "reports available but unauthenticated when `--version` times out and `account show` exits non-zero",
  () =>
    Effect.gen(function* () {
      const { process } = makeProcess((input) => {
        if (isVersionCall(input)) {
          return Effect.fail(
            new VcsProcessTimeoutError({
              operation: input.operation,
              command: input.command,
              cwd: input.cwd,
              timeoutMs: input.timeoutMs ?? 0,
            }),
          );
        }
        return Effect.succeed(
          processOutput("", {
            stderr: "ERROR: Please run 'az login' to setup account.",
            exitCode: ChildProcessSpawner.ExitCode(1),
          }),
        );
      });

      const item = yield* probeSourceControlProvider({
        spec: AzureDevOps.discovery,
        process,
        cwd: "/repo",
      });

      assert.strictEqual(item.status, "available");
      assert.strictEqual(item.auth.status, "unauthenticated");
    }),
);

it.effect(
  "treats a non-spawn `--version` failure (e.g. a non-zero exit) as present and still runs the auth probe",
  () =>
    Effect.gen(function* () {
      const { process, calls } = makeProcess((input) => {
        if (isVersionCall(input)) {
          return Effect.fail(
            new VcsProcessExitError({
              operation: input.operation,
              command: input.command,
              cwd: input.cwd,
              exitCode: 1,
              detail: "Process exited with a non-zero status.",
            }),
          );
        }
        return Effect.succeed(processOutput("azure-user@example.com\n"));
      });

      const item = yield* probeSourceControlProvider({
        spec: AzureDevOps.discovery,
        process,
        cwd: "/repo",
      });

      // Only a genuine spawn failure means "missing"; any other runtime failure of
      // `--version` (here a non-zero exit) means the CLI is present, so it stays
      // available and the auth probe still runs. (issue #4)
      assert.strictEqual(item.status, "available");
      assert.strictEqual(item.auth.status, "authenticated");
      assert.ok(
        calls.some(isAuthCall),
        "expected the auth probe to run after a non-spawn `--version` failure",
      );
    }),
);
