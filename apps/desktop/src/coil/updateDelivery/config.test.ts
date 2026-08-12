import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_RELAY_URL,
  DISABLE_ENV_VAR,
  encodePendingInstall,
  parseBuildNumber,
  parsePendingInstall,
  readEmbeddedCommitHash,
  relayEndpoints,
  RELAY_URL_ENV_VAR,
  resolveRelayUrl,
} from "./config.ts";

describe("resolveRelayUrl", () => {
  it("defaults to the fork's relay", () => {
    expect(resolveRelayUrl({})).toBe(DEFAULT_RELAY_URL);
  });

  it("honours an override", () => {
    expect(resolveRelayUrl({ [RELAY_URL_ENV_VAR]: "https://example.test" })).toBe(
      "https://example.test",
    );
  });

  it("ignores an override that is only whitespace", () => {
    expect(resolveRelayUrl({ [RELAY_URL_ENV_VAR]: "   " })).toBe(DEFAULT_RELAY_URL);
  });

  it("returns nothing when delivery is disabled, so no subscriber starts at all", () => {
    expect(resolveRelayUrl({ [DISABLE_ENV_VAR]: "1" })).toBeUndefined();
  });

  it("treats an empty disable flag as not disabled", () => {
    // `FOO=` in a shell sets the variable to "". Reading that as "disabled" would turn a common
    // typo into a silently non-updating app.
    expect(resolveRelayUrl({ [DISABLE_ENV_VAR]: "" })).toBe(DEFAULT_RELAY_URL);
  });
});

describe("relayEndpoints", () => {
  it("builds both endpoints", () => {
    expect(relayEndpoints("https://relay.test")).toEqual({
      events: "https://relay.test/events",
      latest: "https://relay.test/latest",
    });
  });

  it("does not double the slash on a trailing-slash base", () => {
    expect(relayEndpoints("https://relay.test///").latest).toBe("https://relay.test/latest");
  });
});

describe("parseBuildNumber", () => {
  it("reads the counter this fork's release workflow writes", () => {
    expect(parseBuildNumber("0.0.33-coil.101")).toBe(101);
  });

  it("still reads the pre-rename counter", () => {
    // #71 renamed the suffix. This case is not nostalgia: every published build up to 26 carries
    // `-t3x.<n>`, and dropping it would make those versions parse as `undefined` — "no ordering
    // floor" — which is the one answer that lets an OLDER build look installable.
    expect(parseBuildNumber("0.0.31-t3x.44")).toBe(44);
  });

  it("orders across the rename, because the counter never restarted", () => {
    // The whole point of the +100 offset in coil-release.yml. Nothing compares the suffixes —
    // which is just as well, since "coil" sorts before "t3x".
    const before = parseBuildNumber("0.0.33-t3x.26");
    const after = parseBuildNumber("0.0.33-coil.101");
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after!).toBeGreaterThan(before!);
  });

  it("has no counter for an upstream build", () => {
    // Which `decideUpdateAction` reads as "no ordering floor" — so the first fork build installs
    // over an upstream one rather than being refused as not-newer.
    expect(parseBuildNumber("0.0.31")).toBeUndefined();
  });

  it("ignores a counter that is not at the end", () => {
    expect(parseBuildNumber("0.0.33-coil.101+meta")).toBeUndefined();
    expect(parseBuildNumber("0.0.31-t3x.44+meta")).toBeUndefined();
  });

  it("rejects zero and negatives", () => {
    expect(parseBuildNumber("0.0.33-coil.0")).toBeUndefined();
    expect(parseBuildNumber("0.0.33-coil.-1")).toBeUndefined();
    expect(parseBuildNumber("0.0.31-t3x.0")).toBeUndefined();
  });
});

describe("readEmbeddedCommitHash", () => {
  it("truncates to the 12 characters the manifest compares against", () => {
    expect(readEmbeddedCommitHash(JSON.stringify({ t3codeCommitHash: "ABCDEF0123456789abcd" }))).toBe(
      "abcdef012345",
    );
  });

  it("is undefined when the field is absent", () => {
    expect(readEmbeddedCommitHash(JSON.stringify({ name: "t3code" }))).toBeUndefined();
  });

  it("is undefined for a non-hex value", () => {
    // Notably "unknown", which `build-desktop-artifact.ts` writes when git fails during a build.
    expect(readEmbeddedCommitHash(JSON.stringify({ t3codeCommitHash: "unknown" }))).toBeUndefined();
  });

  it("is undefined for unparseable JSON rather than throwing", () => {
    expect(readEmbeddedCommitHash("{not json")).toBeUndefined();
  });
});

describe("parsePendingInstall", () => {
  it("reads back what recordPendingInstall wrote", () => {
    const encoded = encodePendingInstall({
      shortSha: "dd90bbace7c3",
      version: "0.0.31-coil.6",
    });
    expect(parsePendingInstall(encoded)).toEqual({
      shortSha: "dd90bbace7c3",
      version: "0.0.31-coil.6",
    });
  });

  it("treats the legacy empty marker as 'updated before, nothing pending'", () => {
    // Every marker written before the target was recorded is an empty file. Reading that as
    // corruption would re-show the one-time macOS permission note on an app that had seen it.
    expect(parsePendingInstall("")).toBeUndefined();
    expect(parsePendingInstall("   \n")).toBeUndefined();
  });

  it("does not throw on a truncated or garbage marker", () => {
    // A crash mid-write leaves a partial file. That must degrade to "nothing pending", never to
    // an exception on the boot path.
    expect(parsePendingInstall('{"shortSha":"dd90bb')).toBeUndefined();
    expect(parsePendingInstall("not json at all")).toBeUndefined();
  });

  it("rejects a well-formed object missing the fields it needs", () => {
    expect(parsePendingInstall('{"shortSha":"dd90bbace7c3"}')).toBeUndefined();
  });
});
