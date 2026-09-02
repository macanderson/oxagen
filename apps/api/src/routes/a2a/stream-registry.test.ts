import { describe, expect, it, vi } from "vitest";
import {
  _hasEntryForTest,
  _listenerCountForTest,
  publish,
  subscribe,
} from "./stream-registry";
import { logger } from "../../middleware/logger";

const STATUS_EVENT = {
  kind: "status-update" as const,
  taskId: "a2a_1",
  contextId: "ctx_1",
  status: { state: "working" as const, timestamp: new Date().toISOString() },
  final: false,
};

describe("stream-registry", () => {
  it("publish before any subscriber is a no-op (never throws)", () => {
    expect(() => publish("a2a_no_subscribers", STATUS_EVENT)).not.toThrow();
  });

  it("delivers a published event to a subscribed listener", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribe("a2a_1", (e) => received.push(e));
    publish("a2a_1", STATUS_EVENT);
    expect(received).toEqual([STATUS_EVENT]);
    unsubscribe();
  });

  it("delivers to multiple listeners on the same task id", () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const unsubA = subscribe("a2a_multi", (e) => a.push(e));
    const unsubB = subscribe("a2a_multi", (e) => b.push(e));
    publish("a2a_multi", STATUS_EVENT);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    unsubA();
    unsubB();
  });

  it("does not deliver to listeners subscribed to a different task id", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribe("a2a_other", (e) => received.push(e));
    publish("a2a_unrelated", STATUS_EVENT);
    expect(received).toHaveLength(0);
    unsubscribe();
  });

  it("unsubscribe removes the listener from the Map (no leak)", () => {
    const unsubscribe = subscribe("a2a_leak", () => undefined);
    expect(_listenerCountForTest("a2a_leak")).toBe(1);
    expect(_hasEntryForTest("a2a_leak")).toBe(true);

    unsubscribe();

    // The empty Set itself must be removed, not just emptied — a Map entry
    // per short-lived task id left behind is a slow memory leak.
    expect(_listenerCountForTest("a2a_leak")).toBe(0);
    expect(_hasEntryForTest("a2a_leak")).toBe(false);
  });

  it("unsubscribe is idempotent — calling it twice does not throw or double-decrement", () => {
    const unsubscribe = subscribe("a2a_double", () => undefined);
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
    expect(_hasEntryForTest("a2a_double")).toBe(false);
  });

  it("unsubscribing one of several listeners leaves the others intact", () => {
    const unsubA = subscribe("a2a_partial", () => undefined);
    subscribe("a2a_partial", () => undefined);
    expect(_listenerCountForTest("a2a_partial")).toBe(2);
    unsubA();
    expect(_listenerCountForTest("a2a_partial")).toBe(1);
    expect(_hasEntryForTest("a2a_partial")).toBe(true);
  });

  it("a listener that throws does not prevent delivery to other listeners", async () => {
    // Listener failures now go through the structured pino logger (not
    // console.error) so they land in the queryable log stream.
    const { logger } = await import("../../middleware/logger");
    const warnSpy = vi
      .spyOn(logger, "warn")
      .mockImplementation(() => undefined);
    const received: unknown[] = [];
    const unsubBad = subscribe("a2a_throws", () => {
      throw new Error("listener boom");
    });
    const unsubGood = subscribe("a2a_throws", (e) => received.push(e));
    expect(() => publish("a2a_throws", STATUS_EVENT)).not.toThrow();
    expect(received).toEqual([STATUS_EVENT]);
    expect(warnSpy).toHaveBeenCalled();
    unsubBad();
    unsubGood();
    warnSpy.mockRestore();
  });
});
