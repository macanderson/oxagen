/**
 * Tests for retrieval/vector.ts — VectorRetrievalEngine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { VectorRetrievalEngine, type EmbedFn, type VectorQueryFn } from "./vector";
import { DuckDBEpisodicStore } from "../store/duckdb-adapter";
import { createRecord } from "../record";
import type { Namespace, Provenance } from "../types";
import type { RetrievalQuery } from "./types";

const NS: Namespace = { org: "test-org", workspace: "test-ws" };
const PROV: Provenance = { author: "test", derivedFrom: [], timestamp: Date.now() };

const FAKE_EMBEDDING = [0.1, 0.2, 0.3];

function makeQuery(overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    namespace: NS,
    taskDescription: "find auth memories",
    workingSet: [],
    recentEventIds: [],
    limit: 10,
    ...overrides,
  };
}

describe("VectorRetrievalEngine", () => {
  let store: DuckDBEpisodicStore;
  let embedFn: EmbedFn;
  let vectorQuery: VectorQueryFn;

  beforeEach(() => {
    store = new DuckDBEpisodicStore({ path: ":memory:" });
    embedFn = vi.fn(async (_text: string): Promise<number[]> => FAKE_EMBEDDING);
    vectorQuery = vi.fn(async () => []);
  });

  afterEach(async () => {
    await store.close();
  });

  it("returns empty array when taskDescription is empty", async () => {
    const engine = new VectorRetrievalEngine(store, embedFn, vectorQuery);
    const results = await engine.retrieve(makeQuery({ taskDescription: "" }));
    expect(results).toHaveLength(0);
    expect(embedFn).not.toHaveBeenCalled();
  });

  it("returns empty array when vector query returns no results", async () => {
    const engine = new VectorRetrievalEngine(store, embedFn, vectorQuery);
    const results = await engine.retrieve(makeQuery());
    expect(results).toHaveLength(0);
  });

  it("embeds the task description", async () => {
    const engine = new VectorRetrievalEngine(store, embedFn, vectorQuery);
    await engine.retrieve(makeQuery({ taskDescription: "auth flow" }));
    expect(embedFn).toHaveBeenCalledWith("auth flow");
  });

  it("passes embedding to vector query with correct opts", async () => {
    let capturedEmbedding: number[] = [];
    let capturedOpts: { orgId: string; workspaceId: string; limit: number } = { orgId: "", workspaceId: "", limit: 0 };
    vectorQuery = vi.fn(async (emb: number[], opts: { orgId: string; workspaceId: string; limit: number }) => {
      capturedEmbedding = emb;
      capturedOpts = opts;
      return [];
    });

    const engine = new VectorRetrievalEngine(store, embedFn, vectorQuery);
    await engine.retrieve(makeQuery({ limit: 7 }));

    expect(capturedEmbedding).toEqual(FAKE_EMBEDDING);
    expect(capturedOpts.orgId).toBe("test-org");
    expect(capturedOpts.workspaceId).toBe("test-ws");
    expect(capturedOpts.limit).toBe(7);
  });

  it("retrieves and wraps records from vector query results", async () => {
    const record = createRecord({
      kind: "semantic",
      namespace: NS,
      body: { fact: "JWT is used for auth", domain: "auth" },
      salience: 0.8,
      confidence: 0.9,
      provenance: PROV,
    });
    await store.append(record);

    vectorQuery = vi.fn(async () => [{ recordId: record.id, score: 0.92 }]);
    const engine = new VectorRetrievalEngine(store, embedFn, vectorQuery);
    const results = await engine.retrieve(makeQuery());

    expect(results).toHaveLength(1);
    expect(results[0]!.record.id).toBe(record.id);
    expect(results[0]!.source).toBe("vector");
    expect(results[0]!.score).toBeCloseTo(0.92, 5);
  });

  it("clamps score to 1.0", async () => {
    const record = createRecord({
      kind: "episodic",
      namespace: NS,
      body: { event: "test", payload: {} },
      salience: 0.5,
      confidence: 1.0,
      provenance: PROV,
    });
    await store.append(record);

    vectorQuery = vi.fn(async () => [{ recordId: record.id, score: 1.5 }]);
    const engine = new VectorRetrievalEngine(store, embedFn, vectorQuery);
    const results = await engine.retrieve(makeQuery());

    expect(results[0]!.score).toBe(1.0);
  });

  it("omits records not found in store", async () => {
    vectorQuery = vi.fn(async () => [{ recordId: "missing-id", score: 0.9 }]);
    const engine = new VectorRetrievalEngine(store, embedFn, vectorQuery);
    const results = await engine.retrieve(makeQuery());
    expect(results).toHaveLength(0);
  });

  it("has name property 'vector'", () => {
    const engine = new VectorRetrievalEngine(store, embedFn, vectorQuery);
    expect(engine.name).toBe("vector");
  });

  it("uses score 0 for records missing from score map", async () => {
    const record = createRecord({
      kind: "episodic",
      namespace: NS,
      body: { event: "test", payload: {} },
      salience: 0.5,
      confidence: 1.0,
      provenance: PROV,
    });
    await store.append(record);

    // Vector query returns id that won't be in the score map after getByIds
    vectorQuery = vi.fn(async () => [{ recordId: record.id, score: 0.75 }]);
    const engine = new VectorRetrievalEngine(store, embedFn, vectorQuery);
    const results = await engine.retrieve(makeQuery());

    // Should use the score from the score map
    expect(results[0]!.score).toBe(0.75);
  });

  it("estimates token cost from body size", async () => {
    const body = { fact: "x".repeat(400), domain: "test" };
    const record = createRecord({
      kind: "semantic",
      namespace: NS,
      body,
      salience: 0.5,
      confidence: 0.9,
      provenance: PROV,
    });
    await store.append(record);

    vectorQuery = vi.fn(async () => [{ recordId: record.id, score: 0.5 }]);
    const engine = new VectorRetrievalEngine(store, embedFn, vectorQuery);
    const results = await engine.retrieve(makeQuery());

    expect(results[0]!.tokenCost).toBeGreaterThan(50);
  });

  it("P0-1: emits records in the ANN score order, not store order", async () => {
    // Seed three records; the store returns them in some internal (insertion)
    // order via getByIds. The engine must re-emit them in the vectorQuery
    // (score-descending) order so fusion's array-index-as-rank is correct.
    const mk = (fact: string) =>
      createRecord({
        kind: "semantic",
        namespace: NS,
        body: { fact, domain: "auth" },
        salience: 0.5,
        confidence: 0.9,
        provenance: PROV,
      });
    const r1 = mk("first-inserted");
    const r2 = mk("second-inserted");
    const r3 = mk("third-inserted");
    await store.append(r1);
    await store.append(r2);
    await store.append(r3);

    // Score order is r3 > r1 > r2 — deliberately different from insertion order.
    vectorQuery = vi.fn(async () => [
      { recordId: r3.id, score: 0.99 },
      { recordId: r1.id, score: 0.80 },
      { recordId: r2.id, score: 0.60 },
    ]);
    const engine = new VectorRetrievalEngine(store, embedFn, vectorQuery);
    const results = await engine.retrieve(makeQuery());

    expect(results.map((c) => c.record.id)).toEqual([r3.id, r1.id, r2.id]);
    expect(results.map((c) => c.score)).toEqual([0.99, 0.8, 0.6]);
  });
});
