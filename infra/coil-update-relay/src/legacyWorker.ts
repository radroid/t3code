/**
 * The `t3x-update-relay` hostname, after #71 moved the real relay to `coil-update-relay`.
 *
 * This exists because `DEFAULT_RELAY_URL` is compiled into the app. Every build ever shipped has
 * `https://t3x-update-relay.businesses.workers.dev` baked in, the env override that could point
 * them elsewhere is never set on a normal install (a `.app` launched from Finder inherits
 * launchd's environment, not a shell's), and an app that stops finding its relay has no remaining
 * channel through which to be told. So this hostname has to keep answering for as long as any
 * build that predates the rename is still running — which is indefinitely, and certainly longer
 * than it will feel necessary.
 *
 * ## Why a proxy and not a redirect
 *
 * The obvious shim is a 301/307 to the new host. It is the wrong one here, and the reason is
 * specific rather than stylistic: `relayClient.ts` does not use `fetch`. It goes through Effect's
 * `HttpClient`, and it classifies any non-2xx response as `bad-status` on BOTH tiers — the
 * `/latest` poll and the long-lived `/events` stream. Whether that client transparently follows a
 * redirect, and whether it does so on a `text/event-stream` response it intends to keep open, is
 * not a property that can be tested against builds that are already installed on other people's
 * machines. Being wrong about it does not degrade those builds, it strands them, permanently and
 * without a symptom — which is the exact failure this whole file exists to prevent.
 *
 * A pass-through has no such question attached. From the client's side the bytes, the status and
 * the streaming behaviour are what they were before the rename, because they are literally the
 * upstream response.
 *
 * ## Why it forwards every method and path
 *
 * Including `/notify`, which only the release workflow calls. The workflow is *supposed* to post
 * to the new host, but that target lives in a repo variable rather than in this repository, so
 * "supposed to" is an assumption about a value nobody here can see. Forwarding it costs one line
 * and makes the shim correct whichever host the workflow was pointed at. The HMAC signature
 * covers the body and the timestamp, not the hostname, so it survives the hop unchanged.
 *
 * ## Why `UpdateChannel` is still exported
 *
 * It is unreachable from here — nothing below touches the binding. It stays because this Worker is
 * deployed OVER the existing `t3x-update-relay`, which already has the Durable Object class in its
 * migration history. Dropping the export would make the deploy an implicit class deletion, which
 * Cloudflare rejects without an explicit `deleted_classes` migration; keeping it makes the cutover
 * a plain code deploy, and makes rolling back to the real relay a plain code deploy too.
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
 * The forwarded request: the upstream's origin, the caller's everything else.
 *
 * The `host` header is reset alongside the URL. It does not affect routing here — the service
 * binding dispatches by binding, not by hostname — but `new Request(newUrl, oldRequest)` copies
 * headers verbatim, and a request whose URL and `host` disagree is the kind of detail that reads as
 * a bug to whoever debugs the next thing.
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
