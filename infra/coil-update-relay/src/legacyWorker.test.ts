import { describe, expect, it, vi } from "vite-plus/test";

// Same stand-in, and for the same reason, as worker.test.ts: the entry module re-exports the
// Durable Object class because wrangler requires it, which drags in `cloudflare:workers` — a
// runtime-only module with no node equivalent. The shim never touches the class; it is exported
// only so deploying over the existing Worker is not read as a class deletion.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected readonly ctx = undefined;
  },
}));

import { buildUpstreamRequest, rewriteToUpstream, UPSTREAM_ORIGIN } from "./legacyWorker.ts";

describe("rewriteToUpstream", () => {
  it("keeps the path and moves only the origin", () => {
    expect(rewriteToUpstream("https://t3x-update-relay.businesses.workers.dev/latest")).toBe(
      `${UPSTREAM_ORIGIN}/latest`,
    );
    expect(rewriteToUpstream("https://t3x-update-relay.businesses.workers.dev/events")).toBe(
      `${UPSTREAM_ORIGIN}/events`,
    );
  });

  it("forwards /notify too, so the shim is correct whichever host the release posts to", () => {
    // The release workflow's target lives in a repo variable, not in this repository. Forwarding
    // this path costs nothing and removes an assumption about a value nobody here can read. The
    // HMAC covers the body and timestamp, not the hostname, so it survives the hop.
    expect(rewriteToUpstream("https://t3x-update-relay.businesses.workers.dev/notify")).toBe(
      `${UPSTREAM_ORIGIN}/notify`,
    );
  });

  it("preserves the query string", () => {
    expect(
      rewriteToUpstream("https://t3x-update-relay.businesses.workers.dev/latest?x=1&y=2"),
    ).toBe(`${UPSTREAM_ORIGIN}/latest?x=1&y=2`);
  });

  it("does not smuggle the old host into the target", () => {
    // A rewrite built by string concatenation rather than by URL would happily produce
    // `https://coil-.../https://t3x-...`. Asserted because the failure mode is a 404 on every
    // request from every installed build.
    const target = new URL(
      rewriteToUpstream("https://t3x-update-relay.businesses.workers.dev/latest"),
    );
    expect(target.host).toBe(new URL(UPSTREAM_ORIGIN).host);
    expect(target.pathname).toBe("/latest");
  });

  it("points at the renamed relay, not back at itself", () => {
    // A shim that forwards to its own hostname is an infinite loop that Cloudflare bills for.
    expect(UPSTREAM_ORIGIN).not.toContain("t3x-update-relay");
    expect(UPSTREAM_ORIGIN).toContain("coil-update-relay");
  });
});

describe("buildUpstreamRequest", () => {
  const incoming = (url: string, init?: RequestInit) =>
    new Request(url, { headers: { host: "t3x-update-relay.businesses.workers.dev" }, ...init });

  it("repoints the host header at the upstream", () => {
    // `new Request(newUrl, oldRequest)` copies headers verbatim, `host` included, so without this
    // the forwarded request's URL and `host` name different Workers.
    const forwarded = buildUpstreamRequest(
      incoming("https://t3x-update-relay.businesses.workers.dev/latest"),
    );

    expect(forwarded.headers.get("host")).toBe(new URL(UPSTREAM_ORIGIN).host);
    expect(forwarded.url).toBe(`${UPSTREAM_ORIGIN}/latest`);
  });

  it("keeps the method and the headers the relay authenticates on", () => {
    // /notify is signed over `<timestamp>.<body>`; the hop must not disturb either header.
    const forwarded = buildUpstreamRequest(
      incoming("https://t3x-update-relay.businesses.workers.dev/notify", {
        method: "POST",
        headers: {
          host: "t3x-update-relay.businesses.workers.dev",
          "content-type": "application/json",
          "x-coil-timestamp": "1786500000",
          "x-coil-signature": "sha256=abc",
        },
        body: '{"buildNumber":1}',
      }),
    );

    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("x-coil-timestamp")).toBe("1786500000");
    expect(forwarded.headers.get("x-coil-signature")).toBe("sha256=abc");
    expect(forwarded.headers.get("content-type")).toBe("application/json");
  });
});
