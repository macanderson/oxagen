/**
 * Additional tests for sync/priority.ts — batchByPriority.
 * The prioritizeForSync tests live in sync.test.ts.
 */
import { describe, it, expect } from "vitest";
import { batchByPriority, prioritizeForSync } from "./priority";
import { createRecord } from "../record";
import type { Namespace, Provenance } from "../types";

const NS: Namespace = { org: "test-org", workspace: "test-ws" };
const PROV: Provenance = {
  author: "test",
  derivedFrom: [],
  timestamp: Date.now(),
};

function makeRecord(
  kind: "episodic" | "semantic" | "procedural" | "entity" | "edge",
  salience: number,
) {
  switch (kind) {
    case "episodic":
      return createRecord({
        kind,
        namespace: NS,
        body: { event: `event-${Math.random()}`, payload: {} },
        salience,
        confidence: 1,
        provenance: PROV,
      });
    case "semantic":
      return createRecord({
        kind,
        namespace: NS,
        body: { fact: `fact-${Math.random()}`, domain: "test" },
        salience,
        confidence: 1,
        provenance: PROV,
      });
    case "procedural":
      return createRecord({
        kind,
        namespace: NS,
        body: {
          rule: `rule-${Math.random()}`,
          appliesTo: [],
          successCount: 0,
          failureCount: 0,
        },
        salience,
        confidence: 1,
        provenance: PROV,
      });
    case "entity":
      return createRecord({
        kind,
        namespace: NS,
        body: {
          entityType: "file",
          name: `file-${Math.random()}`,
          properties: {},
        },
        salience,
        confidence: 1,
        provenance: PROV,
      });
    case "edge":
      return createRecord({
        kind,
        namespace: NS,
        body: { sourceId: "a", targetId: "b", edgeType: "DEPENDS_ON" },
        salience,
        confidence: 1,
        provenance: PROV,
      });
  }
}

describe("batchByPriority", () => {
  it("returns empty array for empty input", () => {
    expect(batchByPriority([])).toHaveLength(0);
  });

  it("returns single batch when records fit in one batch", () => {
    const records = [makeRecord("semantic", 0.8), makeRecord("episodic", 0.5)];
    const batches = batchByPriority(records, 100);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it("splits into multiple batches according to batchSize", () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      makeRecord("episodic", 0.5 + i * 0.01),
    );
    const batches = batchByPriority(records, 3);
    expect(batches.length).toBe(4); // 10 / 3 = ceil(10/3) = 4 batches
    expect(batches[0]).toHaveLength(3);
    expect(batches[1]).toHaveLength(3);
    expect(batches[2]).toHaveLength(3);
    expect(batches[3]).toHaveLength(1);
  });

  it("default batch size is 100", () => {
    const records = Array.from({ length: 150 }, () =>
      makeRecord("episodic", 0.5),
    );
    const batches = batchByPriority(records);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(100);
    expect(batches[1]).toHaveLength(50);
  });

  it("first batch contains highest-priority records", () => {
    const low = makeRecord("episodic", 0.1);
    const high = makeRecord("semantic", 0.9);
    const mid = makeRecord("procedural", 0.5);

    const batches = batchByPriority([low, mid, high], 2);
    // First batch should have the highest salience records
    expect(batches[0]).toContainEqual(expect.objectContaining({ id: high.id }));
  });

  it("sorts within each batch by priority", () => {
    const records = [
      makeRecord("edge", 0.9), // low kind priority but high salience
      makeRecord("semantic", 0.5), // high kind priority but lower salience
    ];
    const batches = batchByPriority(records, 10);
    // edge with salience 0.9 should come first (salience is primary sort)
    expect(batches[0]![0]!.salience).toBeGreaterThanOrEqual(
      batches[0]![1]!.salience,
    );
  });

  it("preserves all records across all batches", () => {
    const records = Array.from({ length: 25 }, (_, i) =>
      makeRecord(i % 2 === 0 ? "semantic" : "episodic", Math.random()),
    );
    const batches = batchByPriority(records, 7);
    const totalInBatches = batches.reduce((sum, b) => sum + b.length, 0);
    expect(totalInBatches).toBe(25);
  });
});

describe("prioritizeForSync (additional)", () => {
  it("returns empty array for empty input", () => {
    expect(prioritizeForSync([])).toHaveLength(0);
  });

  it("stable sort: same salience and kind, sorts by createdAt DESC", () => {
    const now = Date.now();
    const older = { ...makeRecord("semantic", 0.8), createdAt: now - 1000 };
    const newer = { ...makeRecord("semantic", 0.8), createdAt: now };
    const sorted = prioritizeForSync([older, newer]);
    expect(sorted[0]!.createdAt).toBeGreaterThan(sorted[1]!.createdAt);
  });

  it("kind priority: semantic > procedural > episodic > entity > edge", () => {
    const records = [
      makeRecord("edge", 0.5),
      makeRecord("entity", 0.5),
      makeRecord("episodic", 0.5),
      makeRecord("procedural", 0.5),
      makeRecord("semantic", 0.5),
    ];
    const sorted = prioritizeForSync(records);
    // All have same salience, so kind priority determines order
    expect(sorted[0]!.kind).toBe("semantic");
    expect(sorted[1]!.kind).toBe("procedural");
    expect(sorted[2]!.kind).toBe("episodic");
    expect(sorted[3]!.kind).toBe("entity");
    expect(sorted[4]!.kind).toBe("edge");
  });
});
