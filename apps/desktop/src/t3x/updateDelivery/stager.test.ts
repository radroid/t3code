import { describe, expect, it } from "vite-plus/test";

import { parseDfAvailableBytes, stagedFileName } from "./stager.ts";

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
