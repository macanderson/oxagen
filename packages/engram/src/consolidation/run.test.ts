/**
 * Phase D end to end, against a real DuckDB store.
 *
 * The issue this covers is not a wrong answer — it is that nothing ever asked.
 * `evictExpired` and `updateSalience` were implemented and had no caller
 * outside their own tests, so a record's TTL passed and it stayed, and salience
 * stayed frozen at creation (#1418). These drive the store, not a fake, because
 * the gap was between the pure functions and the thing that stores rows.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore } from "../store";
import type { EpisodicStore } from "../store/episodic";
import type { MemoryRecord, Namespace } from "../types";
import { runConsolidation } from "./run";

const NS: Namespace = { org: "org_1", workspace: "ws_1" };
const DAY = 24 * 60 * 60 * 1000;

function record(over: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    kind: "semantic",
    namespace: NS,
    body: { fact: `fact ${over.id}`, domain: "test" },
    salience: 0.5,
    confidence: 0.9,
    provenance: { source: "test", timestamp: 1 },
    causality: [],
    createdAt: 1,
    ...over,
  } as MemoryRecord;
}

let store: EpisodicStore;

beforeEach(() => {
  store = createStore({ duckdbPath: ":memory:" });
});

afterEach(async () => {
  await store.close();
});

describe("runConsolidation evicts expired records (#1418)", () => {
  it("deletes a record whose TTL has passed, and keeps one whose has not", async () => {
    const now = 10 * DAY;
    await store.appendBatch([
      record({ id: "expired", ttl: now - 1 }),
      record({ id: "alive", ttl: now + DAY }),
      record({ id: "no-ttl" }),
    ]);

    const before = await store.query({ namespace: NS, limit: 100 });
    expect(before).toHaveLength(3);

    const report = await runConsolidation({ store, now });

    expect(report.evicted).toBe(1);
    const after = await store.query({ namespace: NS, limit: 100 });
    expect(after.map((r) => r.id).sort()).toEqual(["alive", "no-ttl"]);
  });

  it("reports zero for a store with nothing to do, rather than failing", async () => {
    const report = await runConsolidation({ store, now: Date.now() });
    expect(report.evicted).toBe(0);
    expect(report.namespaces).toEqual([]);
  });
});

describe("runConsolidation reconciles salience", () => {
  it("writes a decayed salience for a record nothing has retrieved", async () => {
    // Frozen at 0.5 forever before this ran, because nothing called
    // updateSalience.
    await store.appendBatch([
      record({ id: "stale", salience: 0.9, createdAt: 1 }),
    ]);

    const report = await runConsolidation({ store, now: 60 * DAY });

    expect(report.written).toBe(1);
    const after = await store.getById("stale");
    expect(after!.salience).toBeLessThan(0.9);
  });

  it("leaves a record alone when the change is below the epsilon", async () => {
    await store.appendBatch([
      record({ id: "fresh", salience: 0.5, createdAt: 1 }),
    ]);
    const report = await runConsolidation({
      store,
      now: 2,
      config: { salienceEpsilon: 0.9 },
    });
    expect(report.written).toBe(0);
    expect((await store.getById("fresh"))!.salience).toBe(0.5);
  });
});

describe("the first pass is bounded (#1418)", () => {
  it("writes at most maxSalienceWrites and defers the rest", async () => {
    // The shape that matters: a store nothing has ever consolidated, where
    // every record's salience is stale at once.
    await store.appendBatch(
      Array.from({ length: 12 }, (_, i) =>
        record({ id: `r${i}`, salience: 0.9, createdAt: 1 }),
      ),
    );

    const report = await runConsolidation({
      store,
      now: 60 * DAY,
      config: { maxSalienceWrites: 5 },
    });

    expect(report.written).toBe(5);
    expect(report.deferred).toBe(7);
  });

  it("a second pass continues where the capped one stopped", async () => {
    await store.appendBatch(
      Array.from({ length: 8 }, (_, i) =>
        record({ id: `r${i}`, salience: 0.9, createdAt: 1 }),
      ),
    );
    const now = 60 * DAY;
    await runConsolidation({ store, now, config: { maxSalienceWrites: 3 } });
    const second = await runConsolidation({
      store,
      now,
      config: { maxSalienceWrites: 3 },
    });

    // The three already written are now within the epsilon, so the second pass
    // spends its budget on records the first one did not reach.
    expect(second.written).toBe(3);
  });
});

describe("reinforcement survives a process restart (#1418)", () => {
  it("persists retrieval and outcome counts to the store", async () => {
    await store.appendBatch([record({ id: "used" }), record({ id: "unused" })]);

    await store.reinforce(["used"], "success", 5_000);
    await store.reinforce(["used"], "success", 6_000);
    await store.reinforce(["used"], "failure", 7_000);

    const stats = await store.readDecayStats(NS);
    expect(stats.get("used")).toEqual({
      retrievals: 3,
      successes: 2,
      lastRetrievedAt: 7_000,
    });
    // A record nothing touched reads as untouched, not as missing.
    expect(stats.get("unused")).toEqual({
      retrievals: 0,
      successes: 0,
      lastRetrievedAt: undefined,
    });
  });

  it("makes lastReinforcedAt readable, which it never was", async () => {
    // The type has carried this field since #1367 and no column held it, so
    // every record came back with it undefined and decay always fell back to
    // createdAt.
    await store.appendBatch([record({ id: "r" })]);
    expect((await store.getById("r"))!.lastReinforcedAt).toBeUndefined();

    await store.reinforce(["r"], "success", 9_000);
    expect((await store.getById("r"))!.lastReinforcedAt).toBe(9_000);
  });

  it("never moves the timestamp backwards", async () => {
    await store.appendBatch([record({ id: "r" })]);
    await store.reinforce(["r"], null, 9_000);
    await store.reinforce(["r"], null, 1_000);
    expect((await store.getById("r"))!.lastReinforcedAt).toBe(9_000);
  });

  it("a reinforced record decays from its last use, not from creation", async () => {
    await store.appendBatch([
      record({ id: "recent", salience: 0.9, createdAt: 1 }),
    ]);
    const now = 60 * DAY;
    await store.reinforce(["recent"], "success", now - 1000);

    await runConsolidation({ store, now });
    const reinforced = (await store.getById("recent"))!.salience;

    // Same record, same age, never used.
    const other = createStore({ duckdbPath: ":memory:" });
    await other.appendBatch([
      record({ id: "recent", salience: 0.9, createdAt: 1 }),
    ]);
    await runConsolidation({ store: other, now });
    const neglected = (await other.getById("recent"))!.salience;
    await other.close();

    expect(reinforced).toBeGreaterThan(neglected);
  });
});
