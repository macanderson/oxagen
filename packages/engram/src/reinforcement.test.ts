/**
 * Tests for reinforcement.ts — ReinforcementTracker.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ReinforcementTracker } from "./reinforcement";
import { DuckDBEpisodicStore } from "./store/duckdb-adapter";
import { createRecord } from "./record";
import type { Namespace, Provenance } from "./types";

const NS: Namespace = { org: "test-org", workspace: "test-ws" };
const PROV: Provenance = { author: "test", derivedFrom: [], timestamp: Date.now() };

function makeRecord(event: string, salience = 0.5) {
  return createRecord({
    kind: "episodic",
    namespace: NS,
    body: { event, payload: {} },
    salience,
    confidence: 1.0,
    provenance: PROV,
  });
}

describe("ReinforcementTracker", () => {
  let tracker: ReinforcementTracker;

  beforeEach(() => {
    tracker = new ReinforcementTracker();
  });

  describe("recordRetrieval", () => {
    it("initializes stats on first retrieval", () => {
      tracker.recordRetrieval("rec-1");
      const stats = tracker.getStats("rec-1");
      expect(stats.recordId).toBe("rec-1");
      expect(stats.retrievalCount).toBe(1);
      expect(stats.successCount).toBe(0);
      expect(stats.failureCount).toBe(0);
    });

    it("increments retrieval count on repeated calls", () => {
      tracker.recordRetrieval("rec-1");
      tracker.recordRetrieval("rec-1");
      tracker.recordRetrieval("rec-1");
      expect(tracker.getStats("rec-1").retrievalCount).toBe(3);
    });

    it("updates lastRetrievedAt timestamp", () => {
      const before = Date.now();
      tracker.recordRetrieval("rec-1");
      const after = Date.now();
      const stats = tracker.getStats("rec-1");
      expect(stats.lastRetrievedAt).toBeGreaterThanOrEqual(before);
      expect(stats.lastRetrievedAt).toBeLessThanOrEqual(after);
    });
  });

  describe("reinforceTurn", () => {
    it("increments successCount on success outcome", () => {
      tracker.recordRetrieval("rec-1");
      tracker.reinforceTurn(["rec-1"], "success");
      expect(tracker.getStats("rec-1").successCount).toBe(1);
      expect(tracker.getStats("rec-1").failureCount).toBe(0);
    });

    it("increments failureCount on failure outcome", () => {
      tracker.recordRetrieval("rec-2");
      tracker.reinforceTurn(["rec-2"], "failure");
      expect(tracker.getStats("rec-2").failureCount).toBe(1);
      expect(tracker.getStats("rec-2").successCount).toBe(0);
    });

    it("initializes stats for unseen records on reinforce", () => {
      tracker.reinforceTurn(["new-rec"], "success");
      const stats = tracker.getStats("new-rec");
      expect(stats.successCount).toBe(1);
      expect(stats.retrievalCount).toBe(0);
    });

    it("reinforces multiple records in one turn", () => {
      tracker.reinforceTurn(["r1", "r2", "r3"], "success");
      expect(tracker.getStats("r1").successCount).toBe(1);
      expect(tracker.getStats("r2").successCount).toBe(1);
      expect(tracker.getStats("r3").successCount).toBe(1);
    });

    it("accumulates across multiple turns", () => {
      tracker.reinforceTurn(["rec-1"], "success");
      tracker.reinforceTurn(["rec-1"], "success");
      tracker.reinforceTurn(["rec-1"], "failure");
      const stats = tracker.getStats("rec-1");
      expect(stats.successCount).toBe(2);
      expect(stats.failureCount).toBe(1);
    });
  });

  describe("getStats", () => {
    it("returns zero stats for unknown record", () => {
      const stats = tracker.getStats("unknown-rec");
      expect(stats.recordId).toBe("unknown-rec");
      expect(stats.retrievalCount).toBe(0);
      expect(stats.successCount).toBe(0);
      expect(stats.failureCount).toBe(0);
      expect(stats.lastRetrievedAt).toBe(0);
    });
  });

  describe("getStatsMap", () => {
    it("returns empty map when no stats", () => {
      expect(tracker.getStatsMap().size).toBe(0);
    });

    it("returns correct entries", () => {
      tracker.recordRetrieval("r1");
      tracker.reinforceTurn(["r1"], "success");
      const map = tracker.getStatsMap();
      expect(map.has("r1")).toBe(true);
      expect(map.get("r1")!.retrievals).toBe(1);
      expect(map.get("r1")!.successes).toBe(1);
    });
  });

  describe("clear", () => {
    it("clears all stats", () => {
      tracker.recordRetrieval("r1");
      tracker.recordRetrieval("r2");
      tracker.clear();
      expect(tracker.getStatsMap().size).toBe(0);
    });
  });

  describe("applyToStore", () => {
    let store: DuckDBEpisodicStore;

    beforeEach(() => {
      store = new DuckDBEpisodicStore({ path: ":memory:" });
    });

    afterEach(async () => {
      await store.close();
    });

    it("boosts salience for records with high success rate", async () => {
      const record = makeRecord("important-event", 0.5);
      await store.append(record);

      // Simulate 3 successful retrievals (success rate > 0.7, count >= 3)
      tracker.recordRetrieval(record.id);
      tracker.recordRetrieval(record.id);
      tracker.recordRetrieval(record.id);
      tracker.reinforceTurn([record.id], "success");
      tracker.reinforceTurn([record.id], "success");
      tracker.reinforceTurn([record.id], "success");

      const boosted: string[] = [];
      const updateSalience = vi.fn(async (id: string, _salience: number): Promise<void> => {
        boosted.push(id);
      });

      const { boosted: boostCount, penalized } = await tracker.applyToStore(store, updateSalience);

      expect(boostCount).toBe(1);
      expect(penalized).toBe(0);
      expect(boosted).toContain(record.id);
    });

    it("penalizes salience for records with low success rate", async () => {
      const record = makeRecord("bad-event", 0.8);
      await store.append(record);

      // 3 retrievals with 0 successes → success rate = 0 < 0.3
      tracker.recordRetrieval(record.id);
      tracker.recordRetrieval(record.id);
      tracker.recordRetrieval(record.id);
      tracker.reinforceTurn([record.id], "failure");
      tracker.reinforceTurn([record.id], "failure");
      tracker.reinforceTurn([record.id], "failure");

      const penalizedIds: string[] = [];
      const updateSalience = vi.fn(async (id: string, _salience: number): Promise<void> => {
        penalizedIds.push(id);
      });

      const { boosted, penalized } = await tracker.applyToStore(store, updateSalience);

      expect(penalized).toBe(1);
      expect(boosted).toBe(0);
      expect(penalizedIds).toContain(record.id);
    });

    it("does not update salience when record not found in store", async () => {
      tracker.recordRetrieval("ghost-record");
      tracker.reinforceTurn(["ghost-record"], "success");
      tracker.reinforceTurn(["ghost-record"], "success");
      tracker.reinforceTurn(["ghost-record"], "success");

      const updateSalience = vi.fn(async (): Promise<void> => undefined);
      const { boosted, penalized } = await tracker.applyToStore(store, updateSalience);

      expect(boosted).toBe(0);
      expect(penalized).toBe(0);
      expect(updateSalience).not.toHaveBeenCalled();
    });

    it("does not update when retrieval count is below threshold", async () => {
      const record = makeRecord("rare-event", 0.5);
      await store.append(record);

      // Only 2 retrievals — below the >= 3 threshold
      tracker.recordRetrieval(record.id);
      tracker.recordRetrieval(record.id);
      tracker.reinforceTurn([record.id], "success");
      tracker.reinforceTurn([record.id], "success");

      const updateSalience = vi.fn(async (): Promise<void> => undefined);
      const { boosted, penalized } = await tracker.applyToStore(store, updateSalience);

      expect(boosted).toBe(0);
      expect(penalized).toBe(0);
      expect(updateSalience).not.toHaveBeenCalled();
    });

    it("caps boosted salience at 1.0", async () => {
      const record = makeRecord("top-salience", 0.95);
      await store.append(record);

      tracker.recordRetrieval(record.id);
      tracker.recordRetrieval(record.id);
      tracker.recordRetrieval(record.id);
      tracker.reinforceTurn([record.id], "success");
      tracker.reinforceTurn([record.id], "success");
      tracker.reinforceTurn([record.id], "success");

      let newSalience = 0;
      const updateSalience = vi.fn(async (_id: string, sal: number): Promise<void> => {
        newSalience = sal;
      });

      await tracker.applyToStore(store, updateSalience);

      expect(newSalience).toBeLessThanOrEqual(1.0);
    });
  });
});
