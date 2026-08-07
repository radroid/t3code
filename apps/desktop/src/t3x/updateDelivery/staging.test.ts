import { describe, expect, it } from "vite-plus/test";

import {
  checkDiskSpace,
  isPartialDownload,
  MIN_FREE_BYTES_HEADROOM,
  partialDownloadName,
  selectStagingSweep,
  shouldAbandonStaging,
  verifyChecksum,
} from "./staging.ts";

describe("partial downloads", () => {
  it("writes to a .part name", () => {
    // Rename is atomic within a filesystem, so a crash leaves either a .part file — never treated
    // as ready — or a complete verified artifact. Writing straight to the final name would leave a
    // truncated file that passes an existence check and fails at install.
    expect(partialDownloadName("T3Code-abc-arm64.dmg")).toBe("T3Code-abc-arm64.dmg.part");
  });

  it("recognises one", () => {
    expect(isPartialDownload("T3Code-abc-arm64.dmg.part")).toBe(true);
    expect(isPartialDownload("T3Code-abc-arm64.dmg")).toBe(false);
  });
});

describe("checkDiskSpace", () => {
  it("allows a download with room to spare", () => {
    expect(
      checkDiskSpace({ assetBytes: 250_000_000, freeBytes: 40_000_000_000 }).kind,
    ).toBe("sufficient");
  });

  it("refuses when only the download itself would fit", () => {
    // The download is not the peak: the dmg is then mounted and copied to a second full bundle.
    // Filling the disk to deliver an update nobody asked for yet is a bad trade.
    const result = checkDiskSpace({ assetBytes: 250_000_000, freeBytes: 300_000_000 });
    expect(result.kind).toBe("insufficient");
  });

  it("requires headroom beyond the asset", () => {
    const result = checkDiskSpace({
      assetBytes: 250_000_000,
      freeBytes: 250_000_000 + MIN_FREE_BYTES_HEADROOM - 1,
    });
    expect(result.kind).toBe("insufficient");
  });
});

describe("selectStagingSweep", () => {
  const entries = [
    { name: "T3Code-aaaaaaaaaaaa-arm64.dmg", shortSha: "aaaaaaaaaaaa", bytes: 250_000_000 },
    { name: "T3Code-bbbbbbbbbbbb-arm64.dmg", shortSha: "bbbbbbbbbbbb", bytes: 250_000_000 },
    { name: "T3Code-cccccccccccc-arm64.dmg.part", shortSha: "cccccccccccc", bytes: 12_000_000 },
  ];

  it("keeps only the current target", () => {
    // At ~470 MB per merge to main, an unswept directory fills the disk within days.
    const sweep = selectStagingSweep({ entries, targetShortSha: "bbbbbbbbbbbb" });
    expect(sweep.map((entry) => entry.shortSha).sort()).toEqual(["aaaaaaaaaaaa", "cccccccccccc"]);
  });

  it("sweeps a partial download even for the current target", () => {
    // Its bytes were never checksummed, so it cannot be resumed — only re-fetched.
    const sweep = selectStagingSweep({ entries, targetShortSha: "cccccccccccc" });
    expect(sweep.map((entry) => entry.name)).toContain("T3Code-cccccccccccc-arm64.dmg.part");
  });

  it("sweeps everything when nothing is targeted", () => {
    // The startup case after a crash, where no install path ever ran its cleanup.
    expect(selectStagingSweep({ entries, targetShortSha: undefined })).toHaveLength(3);
  });
});

describe("verifyChecksum", () => {
  it("matches ignoring case", () => {
    // shasum and certutil disagree on hex case.
    expect(verifyChecksum("ABC123", "abc123").kind).toBe("match");
  });

  it("reports a mismatch", () => {
    expect(verifyChecksum("a".repeat(64), "b".repeat(64)).kind).toBe("mismatch");
  });
});

describe("shouldAbandonStaging", () => {
  it("abandons an in-flight download when a newer build is announced", () => {
    // Never two concurrent downloads, and never a ready state pointing at a build that is already
    // superseded — that would offer a restart which immediately puts the user behind again.
    expect(
      shouldAbandonStaging({ inFlightShortSha: "aaaaaaaaaaaa", announcedShortSha: "bbbbbbbbbbbb" }),
    ).toBe(true);
  });

  it("keeps going when the same build is re-announced", () => {
    // A reconnect replays the current payload. That must not restart a download in progress.
    expect(
      shouldAbandonStaging({ inFlightShortSha: "aaaaaaaaaaaa", announcedShortSha: "aaaaaaaaaaaa" }),
    ).toBe(false);
  });
});
