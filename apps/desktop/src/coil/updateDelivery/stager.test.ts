import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { assetDownloadClient, parseDfAvailableBytes, stagedFileName } from "./stager.ts";

describe("parseDfAvailableBytes", () => {
  const POSIX_OUTPUT = [
    "Filesystem 1024-blocks      Used Available Capacity Mounted on",
    "/dev/disk3s5  971350180 900000000  61350180      94% /System/Volumes/Data",
  ].join("\n");

  it("reads the Available column and converts 1K blocks to bytes", () => {
    expect(parseDfAvailableBytes(POSIX_OUTPUT)).toBe(61_350_180 * 1024);
  });

  it("tolerates trailing whitespace and blank lines", () => {
    expect(parseDfAvailableBytes(`\n${POSIX_OUTPUT}\n\n`)).toBe(61_350_180 * 1024);
  });

  it("is undefined when there is no data row", () => {
    expect(parseDfAvailableBytes("Filesystem 1024-blocks Used Available Capacity Mounted on")).toBe(
      undefined,
    );
  });

  it("is undefined for empty output", () => {
    expect(parseDfAvailableBytes("")).toBeUndefined();
  });

  it("is undefined when the Available column is not a number", () => {
    // Rather than NaN, which would compare false against every threshold and silently permit a
    // download onto a disk that cannot hold it.
    expect(parseDfAvailableBytes("H\n/dev/disk3s5 971350180 900000000 - 94% /")).toBeUndefined();
  });

  it("accepts a full disk", () => {
    expect(parseDfAvailableBytes("H\n/dev/disk3s5 971350180 971350180 0 100% /")).toBe(0);
  });
});

describe("stagedFileName", () => {
  it("prefixes the build so the sweep can identify it by name alone", () => {
    expect(stagedFileName("abcdef012345", "T3Code-arm64.dmg")).toBe(
      "abcdef012345-T3Code-arm64.dmg",
    );
  });
});

describe("assetDownloadClient", () => {
  const RELEASE_URL = "https://github.com/radroid/t3code/releases/download/t3x-build-abc/app.dmg";
  const SIGNED_URL = "https://release-assets.githubusercontent.com/signed/app.dmg";

  /** Mimics GitHub: the release URL only ever hands back a redirect to a signed asset host. */
  const githubReleaseHost = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        request.url === RELEASE_URL
          ? new Response(null, { status: 302, headers: { location: SIGNED_URL } })
          : new Response("dmg-bytes", { status: 200 }),
      ),
    ),
  );

  it.effect("follows the redirect to the signed asset host", () =>
    Effect.gen(function* () {
      const response = yield* assetDownloadClient(githubReleaseHost).get(RELEASE_URL);
      // 302 here is the bug that broke every update: undici stops at the redirect, and
      // downloadAsset's `status >= 300` check reported it as "HTTP 302 for github.com/...".
      expect(response.status).toBe(200);
    }).pipe(Effect.scoped),
  );

  it.effect("stops at the redirect without the wrapper, which is what made this worth a test", () =>
    Effect.gen(function* () {
      const response = yield* githubReleaseHost.get(RELEASE_URL);
      expect(response.status).toBe(302);
    }).pipe(Effect.scoped),
  );
});
