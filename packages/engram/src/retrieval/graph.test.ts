/**
 * Tests for retrieval/graph.ts — GraphRetrievalEngine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GraphRetrievalEngine, type GraphQueryFn } from "./graph";
import { DuckDBEpisodicStore } from "../store/duckdb-adapter";
import { createRecord } from "../record";
import type { Namespace, Provenance } from "../types";
import type { RetrievalQuery } from "./types";

const NS: Namespace = { org: "test-org", workspace: "test-ws" };
const PROV: Provenance = { author: "test", derivedFrom: [], timestamp: Date.now() };

function makeQuery(overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    namespace: NS,
    taskDescription: "test task",
    workingSet: ["entity-1"],
    recentEventIds: [],
    limit: 10,
    ...overrides,
  };
}

describe("GraphRetrievalEngine", () => {
  let store: DuckDBEpisodicStore;
  let queryFn: GraphQueryFn;

  beforeEach(() => {
    store = new DuckDBEpisodicStore({ path: ":memory:" });
  });

  afterEach(async () => {
    await store.close();
  });

  it("returns empty array when workingSet is empty", async () => {
    queryFn = vi.fn(async () => []);
    const engine = new GraphRetrievalEngine(store, queryFn);
    const results = await engine.retrieve(makeQuery({ workingSet: [] }));
    expect(results).toHaveLength(0);
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("returns empty array when graph query returns no results", async () => {
    queryFn = vi.fn(async () => []);
    const engine = new GraphRetrievalEngine(store, queryFn);
    const results = await engine.retrieve(makeQuery());
    expect(results).toHaveLength(0);
  });

  it("retrieves and wraps records found in graph", async () => {
    const record = createRecord({
      kind: "episodic",
      namespace: NS,
      body: { event: "tool_call", payload: { name: "grep" } },
      salience: 0.7,
      confidence: 1.0,
      provenance: PROV,
    });
    await store.append(record);

    queryFn = vi.fn(async () => [{ recordId: record.id, salience: 0.8 }]);
    const engine = new GraphRetrievalEngine(store, queryFn);
    const results = await engine.retrieve(makeQuery());

    expect(results).toHaveLength(1);
    expect(results[0]!.record.id).toBe(record.id);
    expect(results[0]!.source).toBe("graph");
    expect(results[0]!.score).toBe(0.8);
    expect(results[0]!.tokenCost).toBeGreaterThan(0);
  });

  it("deduplicates records that appear in multiple graph results", async () => {
    const record = createRecord({
      kind: "semantic",
      namespace: NS,
      body: { fact: "test fact", domain: "test" },
      salience: 0.8,
      confidence: 0.9,
      provenance: PROV,
    });
    await store.append(record);

    // Same recordId appears twice (once from REMEMBERS, once from ABOUT)
    queryFn = vi.fn(async () => [
      { recordId: record.id, salience: 0.6 },
      { recordId: record.id, salience: 0.9 },
    ]);
    const engine = new GraphRetrievalEngine(store, queryFn);
    const results = await engine.retrieve(makeQuery());

    expect(results).toHaveLength(1);
    // Uses max salience
    expect(results[0]!.score).toBe(0.9);
  });

  it("clamps score to 1.0 even when salience > 1.0", async () => {
    const record = createRecord({
      kind: "episodic",
      namespace: NS,
      body: { event: "test", payload: {} },
      salience: 0.5,
      confidence: 1.0,
      provenance: PROV,
    });
    await store.append(record);

    queryFn = vi.fn(async () => [{ recordId: record.id, salience: 5.0 }]);
    const engine = new GraphRetrievalEngine(store, queryFn);
    const results = await engine.retrieve(makeQuery());

    expect(results[0]!.score).toBeLessThanOrEqual(1.0);
  });

  it("passes correct params to graph query", async () => {
    let capturedParams: Record<string, unknown> = {};
    queryFn = vi.fn(async (_cypher: string, params: Record<string, unknown>) => {
      capturedParams = params;
      return [];
    });

    const engine = new GraphRetrievalEngine(store, queryFn);
    await engine.retrieve(makeQuery({ workingSet: ["e1", "e2"], limit: 5 }));

    expect(capturedParams["workingSet"]).toEqual(["e1", "e2"]);
    expect(capturedParams["orgId"]).toBe("test-org");
    expect(capturedParams["workspaceId"]).toBe("test-ws");
    expect(capturedParams["limit"]).toBe(5);
  });

  it("handles records not found in store gracefully (omits them)", async () => {
    queryFn = vi.fn(async () => [{ recordId: "nonexistent-id", salience: 0.5 }]);
    const engine = new GraphRetrievalEngine(store, queryFn);
    const results = await engine.retrieve(makeQuery());
    // Record doesn't exist in store → getByIds returns empty → no results
    expect(results).toHaveLength(0);
  });

  it("has name property 'graph'", () => {
    queryFn = vi.fn(async () => []);
    const engine = new GraphRetrievalEngine(store, queryFn);
    expect(engine.name).toBe("graph");
  });

  it("estimates token cost from record body", async () => {
    const body = { event: "tool_call", payload: { large: "x".repeat(400) } };
    const record = createRecord({
      kind: "episodic",
      namespace: NS,
      body,
      salience: 0.5,
      confidence: 1.0,
      provenance: PROV,
    });
    await store.append(record);

    queryFn = vi.fn(async () => [{ recordId: record.id, salience: 0.5 }]);
    const engine = new GraphRetrievalEngine(store, queryFn);
    const results = await engine.retrieve(makeQuery());

    expect(results[0]!.tokenCost).toBeGreaterThan(50);
  });

  it("P0-1: emits records in salience-descending order, not store order", async () => {
    const mk = (fact: string) =>
      createRecord({
        kind: "semantic",
        namespace: NS,
        body: { fact, domain: "auth" },
        salience: 0.5,
        confidence: 1.0,
        provenance: PROV,
      });
    const r1 = mk("first");
    const r2 = mk("second");
    const r3 = mk("third");
    await store.append(r1);
    await store.append(r2);
    await store.append(r3);

    // Graph returns them with r2 highest salience, then r3, then r1 —
    // different from insertion order. Engine must sort by salience desc.
    queryFn = vi.fn(async () => [
      { recordId: r1.id, salience: 0.3 },
      { recordId: r2.id, salience: 0.9 },
      { recordId: r3.id, salience: 0.6 },
    ]);
    const engine = new GraphRetrievalEngine(store, queryFn);
    const results = await engine.retrieve(makeQuery());

    expect(results.map((c) => c.record.id)).toEqual([r2.id, r3.id, r1.id]);
  });

  it("P0-1: dedupes a record seen twice, keeping the higher salience", async () => {
    const r = createRecord({
      kind: "semantic",
      namespace: NS,
      body: { fact: "dup", domain: "auth" },
      salience: 0.5,
      confidence: 1.0,
      provenance: PROV,
    });
    await store.append(r);
    // Same record from both REMEMBERS and ABOUT branches with different salience.
    queryFn = vi.fn(async () => [
      { recordId: r.id, salience: 0.4 },
      { recordId: r.id, salience: 0.8 },
    ]);
    const engine = new GraphRetrievalEngine(store, queryFn);
    const results = await engine.retrieve(makeQuery());
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBeCloseTo(0.8, 5);
  });
});
