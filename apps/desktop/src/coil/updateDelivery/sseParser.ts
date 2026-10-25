/**
 * A minimal Server-Sent Events parser for what the relay sends (`event:`, `data:`, `:` comments).
 * Hand-rolled: Electron's main process has no usable `EventSource` (Node's needs a CLI flag the
 * disabled `nodeOptions` fuse blocks), and an npm dependency missed in the staged production
 * install would only fail with `ERR_MODULE_NOT_FOUND` in the packaged app.
 */

export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

export interface SseParseResult {
  readonly events: readonly SseEvent[];
  /** Bytes that arrived mid-frame. Feed them back in with the next chunk. */
  readonly remainder: string;
  /**
   * True when the chunk contained anything at all, including a comment.
   *
   * The watchdog keys on this rather than on events. A `: ping` comment carries no event but is
   * exactly the proof-of-life the watchdog exists to observe — treating only events as activity
   * would make an idle-but-healthy channel indistinguishable from a dead one.
   */
  readonly sawBytes: boolean;
}

/** Normalises CRLF and lone CR, which some proxies introduce. */
function normalizeNewlines(input: string): string {
  return input.replace(/\r\n?/gu, "\n");
}

export function parseSseChunk(buffer: string, chunk: string): SseParseResult {
  const combined = normalizeNewlines(buffer + chunk);
  const sawBytes = chunk.length > 0;

  // Frames are separated by a blank line. Anything after the last separator is incomplete.
  const separatorIndex = combined.lastIndexOf("\n\n");
  if (separatorIndex < 0) {
    return { events: [], remainder: combined, sawBytes };
  }

  const complete = combined.slice(0, separatorIndex);
  const remainder = combined.slice(separatorIndex + 2);

  const events: SseEvent[] = [];
  for (const frame of complete.split("\n\n")) {
    let event = "message";
    const dataLines: string[] = [];

    for (const line of frame.split("\n")) {
      // A comment. Carries no data, but its arrival is what keeps the watchdog quiet.
      if (line.startsWith(":")) continue;

      const colon = line.indexOf(":");
      if (colon < 0) continue;

      const field = line.slice(0, colon);
      // The spec strips exactly one leading space after the colon, not all whitespace.
      const value = line.slice(colon + 1).replace(/^ /u, "");

      if (field === "event") event = value;
      else if (field === "data") dataLines.push(value);
    }

    if (dataLines.length > 0) {
      events.push({ event, data: dataLines.join("\n") });
    }
  }

  return { events, remainder, sawBytes };
}
