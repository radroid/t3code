import { describe, expect, it } from "vite-plus/test";

import {
  assessConnection,
  FLOOR_POLL_INTERVAL_MS,
  reconnectDelayMs,
  RECONNECT_MAX_DELAY_MS,
  SERVER_HEARTBEAT_INTERVAL_MS,
  WATCHDOG_TIMEOUT_MS,
} from "./connectionHealth.ts";

const NOW = 1_800_000_000_000;

describe("assessConnection", () => {
  it("is healthy while heartbeats keep arriving", () => {
    expect(assessConnection({ lastByteAtMs: NOW - 5_000, nowMs: NOW })).toEqual({ kind: "healthy" });
  });

  it("tolerates a single dropped heartbeat", () => {
    // One missed ping under load must not churn a working connection.
    const silentFor = SERVER_HEARTBEAT_INTERVAL_MS * 2;
    expect(assessConnection({ lastByteAtMs: NOW - silentFor, nowMs: NOW })).toEqual({
      kind: "healthy",
    });
  });

  it("declares the stream stale once it passes the watchdog timeout", () => {
    // THE case this module exists for: socket still open, no error ever raised, no bytes since
    // the laptop woke up. Nothing else in the system notices this.
    const silentFor = WATCHDOG_TIMEOUT_MS + 1;
    expect(assessConnection({ lastByteAtMs: NOW - silentFor, nowMs: NOW })).toEqual({
      kind: "stale",
      silentForMs: silentFor,
    });
  });

  it("treats a long sleep as stale", () => {
    const silentFor = 4 * 60 * 60_000;
    expect(assessConnection({ lastByteAtMs: NOW - silentFor, nowMs: NOW }).kind).toBe("stale");
  });

  it("does not fire exactly at the boundary", () => {
    expect(assessConnection({ lastByteAtMs: NOW - WATCHDOG_TIMEOUT_MS, nowMs: NOW }).kind).toBe(
      "healthy",
    );
  });

  it("survives a clock that jumps backwards", () => {
    // NTP correction or a timezone change can make `now` precede the last byte. A negative
    // silence must never be read as "very stale" and trigger a reconnect storm.
    expect(assessConnection({ lastByteAtMs: NOW + 60_000, nowMs: NOW }).kind).toBe("healthy");
  });
});

describe("watchdog and floor-poll relationship", () => {
  it("detects a dead stream long before the floor poll would", () => {
    // Both must exist. The watchdog makes detection fast; the floor poll makes the worst case
    // BOUNDED even if the watchdog is somehow wrong. Losing the floor poll is what turns a missed
    // update into an outage of unbounded length.
    expect(WATCHDOG_TIMEOUT_MS).toBeLessThan(FLOOR_POLL_INTERVAL_MS);
  });

  it("gives the server at least two heartbeats before giving up", () => {
    expect(WATCHDOG_TIMEOUT_MS).toBeGreaterThanOrEqual(SERVER_HEARTBEAT_INTERVAL_MS * 2);
  });
});

describe("reconnectDelayMs", () => {
  it("grows with each attempt", () => {
    const noJitter = () => 1;
    expect(reconnectDelayMs(0, noJitter)).toBeLessThan(reconnectDelayMs(3, noJitter));
  });

  it("is capped", () => {
    expect(reconnectDelayMs(50, () => 1)).toBe(RECONNECT_MAX_DELAY_MS);
  });

  it("applies full jitter", () => {
    // Every desktop app on the fleet wakes on the same events — a relay deploy, Monday morning
    // lids opening. Unjittered backoff would reconnect them in lockstep against a single Durable
    // Object.
    expect(reconnectDelayMs(5, () => 0)).toBe(0);
    expect(reconnectDelayMs(5, () => 0.5)).toBeLessThan(reconnectDelayMs(5, () => 1));
  });

  it("never returns a negative delay for a negative attempt", () => {
    expect(reconnectDelayMs(-3, () => 1)).toBeGreaterThan(0);
  });
});
