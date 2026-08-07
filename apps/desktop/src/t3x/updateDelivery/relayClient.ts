/**
 * Talking to the relay: one poll, and one long-lived stream.
 *
 * The relay serves the manifest verbatim — `t3x-release.yml` POSTs `t3x-latest.json` to `/notify`,
 * `/latest` re-serves that same body, and `/events` frames it as `event: update`. So both tiers
 * decode with the same schema, and a manifest that fails to decode is dropped in both.
 *
 * There is no `EventSource` in Electron's main process, so the stream is an `HttpClient` response
 * body fed through `parseSseChunk`.
 */

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { assessConnection, WATCHDOG_TIMEOUT_MS } from "./connectionHealth.ts";
import { decodeUpdateManifestJson, type UpdateManifest } from "./manifest.ts";
import { parseSseChunk } from "./sseParser.ts";

/**
 * How often the watchdog looks, not how long it waits.
 *
 * Half the timeout, so a stall is noticed within 1.5× `WATCHDOG_TIMEOUT_MS` at worst. Polling at
 * exactly the timeout could double the detection delay for a stall that begins just after a tick.
 */
const WATCHDOG_POLL_INTERVAL = Duration.millis(WATCHDOG_TIMEOUT_MS / 2);

export class RelayError extends Schema.TaggedErrorClass<RelayError>()("T3xRelayError", {
  reason: Schema.Literals([
    "request-failed",
    "bad-status",
    "read-failed",
    "stream-closed",
    "stream-stalled",
  ]),
  detail: Schema.String,
}) {
  override get message(): string {
    return `t3x update relay: ${this.reason} (${this.detail})`;
  }
}

/**
 * Read `/latest`.
 *
 * A relay that has never been notified answers `null`, and a manifest that will not decode is
 * treated the same way — as "nothing to act on" rather than an error. Both mean the app carries
 * on running the build it has, which is the correct outcome for a backstop poll.
 */
export const fetchLatestManifest = Effect.fn("t3x.updateDelivery.fetchLatest")(function* (
  latestUrl: string,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .get(latestUrl, { headers: { accept: "application/json" } })
    .pipe(
      Effect.mapError((cause) => new RelayError({ reason: "request-failed", detail: cause.message })),
    );

  if (response.status < 200 || response.status >= 300) {
    return yield* new RelayError({ reason: "bad-status", detail: `HTTP ${response.status}` });
  }

  const text = yield* response.text.pipe(
    Effect.mapError((cause) => new RelayError({ reason: "read-failed", detail: cause.message })),
  );

  if (text.trim() === "" || text.trim() === "null") return undefined;
  return yield* decodeUpdateManifestJson(text).pipe(Effect.orElseSucceed(() => undefined));
});

/**
 * Hold a stream open, handing every decodable `update` frame to `onManifest`.
 *
 * Never returns successfully: a stream that ends is a `stream-closed` failure, because from the
 * caller's point of view "the server closed cleanly after fifteen minutes" and "the socket died"
 * need the same response — reconnect and reconcile against `/latest`. Distinguishing them would
 * only create a path where one of the two silently stops retrying.
 *
 * The watchdog runs off ANY byte, including the relay's `: ping` comment. Without the heartbeat, a
 * genuinely quiet channel and a dead socket look identical; with it, silence is diagnostic. This
 * is the failure the design calls out as the real one — not a connection that drops, which is
 * loud, but a connection that stays open and delivers nothing.
 */
export const streamRelayEvents = Effect.fn("t3x.updateDelivery.stream")(function* (args: {
  readonly eventsUrl: string;
  readonly onManifest: (manifest: UpdateManifest) => Effect.Effect<void>;
}) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .get(args.eventsUrl, { headers: { accept: "text/event-stream" } })
    .pipe(
      Effect.mapError((cause) => new RelayError({ reason: "request-failed", detail: cause.message })),
    );

  if (response.status < 200 || response.status >= 300) {
    return yield* new RelayError({ reason: "bad-status", detail: `HTTP ${response.status}` });
  }

  const lastByteAt = yield* Ref.make(yield* Clock.currentTimeMillis);
  const decoder = new TextDecoder();
  let buffer = "";

  const readLoop = response.stream.pipe(
    Stream.runForEach((bytes: Uint8Array) =>
      Effect.gen(function* () {
        const parsed = parseSseChunk(buffer, decoder.decode(bytes, { stream: true }));
        buffer = parsed.remainder;
        if (parsed.sawBytes) {
          yield* Ref.set(lastByteAt, yield* Clock.currentTimeMillis);
        }

        for (const event of parsed.events) {
          if (event.event !== "update") continue;
          // A frame this client cannot read must not kill the stream: the relay is deliberately
          // schema-blind so a newer release can add fields, and an older app has to keep running.
          const manifest = yield* decodeUpdateManifestJson(event.data).pipe(
            Effect.catch((cause) =>
              Effect.logWarning(`t3x: ignoring an undecodable update frame: ${String(cause)}`).pipe(
                Effect.as(undefined),
              ),
            ),
          );
          if (manifest !== undefined) yield* args.onManifest(manifest);
        }
      }),
    ),
    Effect.mapError((cause) => new RelayError({ reason: "read-failed", detail: cause.message })),
    // Reaching the end of the stream IS the failure. The relay caps every connection at 15
    // minutes, so a clean end is the normal case — and it needs the same reconnect-and-reconcile
    // as a dead socket.
    Effect.andThen(new RelayError({ reason: "stream-closed", detail: "server ended the stream" })),
  );

  // The watchdog has to be its own fiber, not a check inside the loop. The failure being caught is
  // a socket that never delivers another byte — so the stream never emits, and any test performed
  // per-emission is a test that never runs. Racing puts the clock outside the thing being timed.
  const watchdog = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(WATCHDOG_POLL_INTERVAL);
      const verdict = assessConnection({
        lastByteAtMs: yield* Ref.get(lastByteAt),
        nowMs: yield* Clock.currentTimeMillis,
      });
      if (verdict.kind === "stale") {
        return yield* new RelayError({
          reason: "stream-stalled",
          detail: `no bytes for ${verdict.silentForMs}ms`,
        });
      }
    }
  });

  return yield* Effect.race(readLoop, watchdog);
}, Effect.scoped);
