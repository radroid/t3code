import { DurableObject } from "cloudflare:workers";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";

import { parseNotification, supersedes } from "./notification.ts";

/**
 * One global broadcast channel: the Worker always addresses it by the same name, because there is
 * exactly one thing to say (which build is current). The payload is public, so there is no
 * per-subscriber state and every connected client gets the same bytes.
 */

/** Interval between `: ping` comments. The client's watchdog is derived from this. */
export const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_INTERVAL = Duration.millis(HEARTBEAT_INTERVAL_MS);

/**
 * Streams are closed after this long and clients reconnect. Hibernation only exists for
 * WebSockets, so every open SSE stream pins this object in memory and DO duration bills on wall
 * time. Capping it bounds the cost at no latency, since clients reconnect and get a replay.
 */
export const STREAM_LIFETIME_MS = 15 * 60_000;
const STREAM_LIFETIME = Duration.millis(STREAM_LIFETIME_MS);

const LATEST_STORAGE_KEY = "latest";

interface StoredPayload {
  readonly buildNumber: number;
  /** The raw notify body, rebroadcast verbatim. The relay never reinterprets the manifest. */
  readonly rawBody: string;
}

interface Subscriber {
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  /** Drives the heartbeat and, by racing a sleep, the stream's own lifetime cap. */
  readonly pump: Fiber.Fiber<void, never>;
}

const encoder = new TextEncoder();

function sseData(rawBody: string): Uint8Array {
  // SSE frames are newline-delimited, so a multi-line JSON body would be parsed as several
  // fields. The notify body is compact JSON in practice, but normalising here means a
  // pretty-printed body can never silently truncate a frame at its first newline.
  const singleLine = rawBody.replace(/\r?\n/gu, "");
  return encoder.encode(`event: update\ndata: ${singleLine}\n\n`);
}

export class UpdateChannel extends DurableObject {
  readonly #subscribers = new Set<Subscriber>();

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/internal/publish" && request.method === "POST") {
      return this.#publish(await request.text());
    }
    if (url.pathname === "/internal/latest" && request.method === "GET") {
      return this.#latest();
    }
    if (url.pathname === "/internal/events" && request.method === "GET") {
      return this.#subscribe();
    }

    return new Response("Not found", { status: 404 });
  }

  async #readStored(): Promise<StoredPayload | null> {
    return (await this.ctx.storage.get<StoredPayload>(LATEST_STORAGE_KEY)) ?? null;
  }

  async #publish(rawBody: string): Promise<Response> {
    const parsed = parseNotification(rawBody);
    if (!parsed.ok) {
      return Response.json({ accepted: false, reason: parsed.failure.kind }, { status: 400 });
    }

    const stored = await this.#readStored();
    if (!supersedes(parsed.envelope.buildNumber, stored?.buildNumber ?? null)) {
      // 409 rather than 200: a rejected notify is a real condition the release workflow should
      // surface, not something to swallow. Two legs racing is expected; silently discarding the
      // loser is how an out-of-order publish becomes invisible.
      return Response.json(
        {
          accepted: false,
          reason: "superseded",
          currentBuildNumber: stored?.buildNumber ?? null,
        },
        { status: 409 },
      );
    }

    const next: StoredPayload = { buildNumber: parsed.envelope.buildNumber, rawBody };
    await this.ctx.storage.put(LATEST_STORAGE_KEY, next);

    const frame = sseData(rawBody);
    // Iterating a copy is deliberate, not redundant: #enqueue drops a subscriber whose peer has
    // gone away, which deletes from this very Set. Iterating it directly would mutate during
    // traversal and skip subscribers — so a single dead connection could silently cost a live one
    // its notification.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const subscriber of [...this.#subscribers]) {
      this.#enqueue(subscriber, frame);
    }

    return Response.json({ accepted: true, buildNumber: next.buildNumber });
  }

  async #latest(): Promise<Response> {
    const stored = await this.#readStored();
    if (stored === null) {
      return new Response("null", {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    return new Response(stored.rawBody, {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  #enqueue(subscriber: Subscriber, chunk: Uint8Array): void {
    try {
      subscriber.controller.enqueue(chunk);
    } catch {
      // The peer went away between our last write and this one. Nothing to report and nothing to
      // retry — drop the subscriber and let it reconnect.
      this.#drop(subscriber);
    }
  }

  #drop(subscriber: Subscriber): void {
    if (!this.#subscribers.delete(subscriber)) return;
    Effect.runFork(Fiber.interrupt(subscriber.pump));
    try {
      subscriber.controller.close();
    } catch {
      // Already closed or errored. Either way the subscriber is gone.
    }
  }

  #subscribe(): Response {
    let subscriber: Subscriber | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        // A comment frame every HEARTBEAT_INTERVAL makes a dead-but-open connection observable
        // to the client's watchdog (this fork once had a 103-minute silent outage from exactly
        // that). Racing the loop against a sleep enforces the lifetime cap: whichever finishes
        // first ends the fiber, and `ensuring` tears the subscriber down either way.
        const heartbeat = Effect.suspend(() => {
          const current = subscriber;
          return current === undefined
            ? Effect.void
            : Effect.sync(() => this.#enqueue(current, encoder.encode(": ping\n\n")));
        }).pipe(Effect.repeat(Schedule.spaced(HEARTBEAT_INTERVAL)), Effect.asVoid);

        const pump = Effect.race(heartbeat, Effect.sleep(STREAM_LIFETIME)).pipe(
          Effect.asVoid,
          Effect.ensuring(
            Effect.sync(() => {
              if (subscriber !== undefined) this.#drop(subscriber);
            }),
          ),
          Effect.orDie,
        );

        const created: Subscriber = { controller, pump: Effect.runFork(pump) };
        subscriber = created;
        this.#subscribers.add(created);

        // Replay-on-connect. Without this a client that connects between releases knows nothing
        // until the next merge, which on a quiet day could be hours.
        const stored = await this.#readStored();
        if (stored !== null) {
          this.#enqueue(created, sseData(stored.rawBody));
        }
      },
      cancel: () => {
        if (subscriber !== undefined) this.#drop(subscriber);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        // Proxies that buffer would defeat both the heartbeat and the push.
        "x-accel-buffering": "no",
      },
    });
  }
}
