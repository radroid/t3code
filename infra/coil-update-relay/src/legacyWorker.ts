/**
 * The old `t3x-update-relay` hostname, kept answering forever because every shipped build has it
 * compiled in. A proxy, not a redirect: whether installed clients' HttpClient follows redirects on
 * SSE is untestable, and being wrong strands them. Every path (even `/notify`) is forwarded, and
 * `UpdateChannel` stays exported so the deploy is not a Durable Object class deletion.
 */

export { UpdateChannel } from "./UpdateChannel.ts";

/**
 * Where the real relay now lives.
 *
 * Hardcoded rather than bound through `wrangler.legacy.jsonc`, so that the shim and the Worker it
 * fronts cannot be configured apart. This file and `wrangler.jsonc`'s `name` are the two halves of
 * one fact and they live in the same package for that reason.
 */
export const UPSTREAM_ORIGIN = "https://coil-update-relay.businesses.workers.dev";

/** The forwarded request: same method, headers, body and path — only the origin changes. */
export function rewriteToUpstream(requestUrl: string): string {
  const url = new URL(requestUrl);
  const target = new URL(UPSTREAM_ORIGIN);
  target.pathname = url.pathname;
  target.search = url.search;
  return target.toString();
}

/**
 * The forwarded request: the upstream's origin, the caller's everything else. `host` is reset
 * alongside the URL even though the service binding ignores it, because `new Request` copies
 * headers verbatim and a URL that disagrees with `host` reads as a bug to whoever debugs next.
 */
export function buildUpstreamRequest(request: Request): Request {
  const forwarded = new Request(rewriteToUpstream(request.url), request);
  forwarded.headers.set("host", new URL(UPSTREAM_ORIGIN).host);
  return forwarded;
}

/**
 * The upstream relay, bound as a service rather than reached over the network.
 *
 * See `wrangler.legacy.jsonc` for why: a subrequest from a Worker to a `workers.dev` hostname on
 * the same account is answered by the edge with an HTML 404 and never reaches the target.
 */
export interface LegacyEnv {
  readonly UPSTREAM: Fetcher;
}

export default {
  fetch(request: Request, env: LegacyEnv): Promise<Response> {
    return env.UPSTREAM.fetch(buildUpstreamRequest(request));
  },
} satisfies ExportedHandler<LegacyEnv>;
