import { describe, expect, it } from "vite-plus/test";

import { parseSseChunk } from "./sseParser.ts";

describe("parseSseChunk", () => {
  it("parses a complete frame", () => {
    const result = parseSseChunk("", 'event: update\ndata: {"buildNumber":3}\n\n');
    expect(result.events).toEqual([{ event: "update", data: '{"buildNumber":3}' }]);
    expect(result.remainder).toBe("");
  });

  it("holds an incomplete frame until the rest arrives", () => {
    // TCP splits wherever it likes. A frame cut mid-JSON must not be parsed as truncated JSON.
    const first = parseSseChunk("", 'event: update\ndata: {"build');
    expect(first.events).toEqual([]);

    const second = parseSseChunk(first.remainder, 'Number":3}\n\n');
    expect(second.events).toEqual([{ event: "update", data: '{"buildNumber":3}' }]);
  });

  it("parses several frames in one chunk", () => {
    const result = parseSseChunk("", "event: update\ndata: a\n\nevent: update\ndata: b\n\n");
    expect(result.events.map((frame) => frame.data)).toEqual(["a", "b"]);
  });

  it("defaults the event name to message", () => {
    expect(parseSseChunk("", "data: hello\n\n").events).toEqual([
      { event: "message", data: "hello" },
    ]);
  });

  it("strips exactly one space after the colon", () => {
    // Per the spec. Stripping all whitespace would corrupt data that legitimately starts with one.
    expect(parseSseChunk("", "data:  padded\n\n").events[0]?.data).toBe(" padded");
  });

  it("joins multi-line data with newlines", () => {
    expect(parseSseChunk("", "data: one\ndata: two\n\n").events[0]?.data).toBe("one\ntwo");
  });

  describe("heartbeat comments", () => {
    it("produces no event", () => {
      expect(parseSseChunk("", ": ping\n\n").events).toEqual([]);
    });

    it("still reports that bytes arrived", () => {
      // This is the whole point of the heartbeat. The watchdog keys on sawBytes, not on events —
      // otherwise a healthy channel with no releases looks identical to a dead socket, and the
      // watchdog either fires constantly or never fires at all.
      expect(parseSseChunk("", ": ping\n\n").sawBytes).toBe(true);
    });

    it("does not disturb a following real frame", () => {
      const result = parseSseChunk("", ": ping\n\nevent: update\ndata: x\n\n");
      expect(result.events).toEqual([{ event: "update", data: "x" }]);
    });
  });

  it("reports no bytes for an empty chunk", () => {
    expect(parseSseChunk("", "").sawBytes).toBe(false);
  });

  it("normalises CRLF from proxies", () => {
    const result = parseSseChunk("", "event: update\r\ndata: x\r\n\r\n");
    expect(result.events).toEqual([{ event: "update", data: "x" }]);
  });

  it("ignores fields it does not implement", () => {
    const result = parseSseChunk("", "id: 7\nretry: 500\nevent: update\ndata: x\n\n");
    expect(result.events).toEqual([{ event: "update", data: "x" }]);
  });

  it("drops a frame that carries no data", () => {
    expect(parseSseChunk("", "event: update\n\n").events).toEqual([]);
  });

  it("survives a chunk boundary inside the frame separator", () => {
    const first = parseSseChunk("", "data: x\n");
    expect(first.events).toEqual([]);
    const second = parseSseChunk(first.remainder, "\n");
    expect(second.events).toEqual([{ event: "message", data: "x" }]);
  });
});
