/**
 * Tests for retrieval/lexical.ts — LexicalRetrievalEngine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LexicalRetrievalEngine, type LexicalSearchFn } from "./lexical";
import { DuckDBEpisodicStore } from "../store/duckdb-adapter";
import { createRecord } from "../record";
import type { Namespace, Provenance } from "../types";
import type { RetrievalQuery } from "./types";

const NS: Namespace = { org: "test-org", workspace: "test-ws" };
const PROV: Provenance = {
  author: "test",
  derivedFrom: [],
  timestamp: Date.now(),
};

function makeQuery(overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    namespace: NS,
    taskDescription: "find auth error NullPointerException",
    workingSet: [],
    recentEventIds: [],
    limit: 10,
    ...overrides,
  };
}

describe("LexicalRetrievalEngine", () => {
  let store: DuckDBEpisodicStore;
  let searchFn: LexicalSearchFn;

  beforeEach(() => {
    store = new DuckDBEpisodicStore({ path: ":memory:" });
    searchFn = vi.fn(async () => []);
  });

  afterEach(async () => {
    await store.close();
  });

  it("returns empty array when taskDescription is empty", async () => {
    const engine = new LexicalRetrievalEngine(store, searchFn);
    const results = await engine.retrieve(makeQuery({ taskDescription: "" }));
    expect(results).toHaveLength(0);
    expect(searchFn).not.toHaveBeenCalled();
  });

  it("returns empty array when search returns no results", async () => {
    const engine = new LexicalRetrievalEngine(store, searchFn);
    const results = await engine.retrieve(makeQuery());
    expect(results).toHaveLength(0);
  });

  it("calls searchFn with the task description", async () => {
    const engine = new LexicalRetrievalEngine(store, searchFn);
    await engine.retrieve(
      makeQuery({ taskDescription: "NullPointerException auth" }),
    );
    expect(searchFn).toHaveBeenCalledWith(
      "NullPointerException auth",
      expect.objectContaining({
        orgId: "test-org",
        workspaceId: "test-ws",
        limit: 10,
      }),
    );
  });

  it("retrieves and wraps records from search results", async () => {
    const record = createRecord({
      kind: "episodic",
      namespace: NS,
      body: {
        event: "error_observed",
        payload: { message: "NullPointerException in auth.ts:42" },
      },
      salience: 0.7,
      confidence: 1.0,
      provenance: PROV,
    });
    await store.append(record);

    searchFn = vi.fn(async () => [{ recordId: record.id, score: 0.88 }]);
    const engine = new LexicalRetrievalEngine(store, searchFn);
    const results = await engine.retrieve(makeQuery());

    expect(results).toHaveLength(1);
    expect(results[0]!.record.id).toBe(record.id);
    expect(results[0]!.source).toBe("lexical");
    expect(results[0]!.score).toBeCloseTo(0.88, 5);
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

    searchFn = vi.fn(async () => [{ recordId: record.id, score: 2.5 }]);
    const engine = new LexicalRetrievalEngine(store, searchFn);
    const results = await engine.retrieve(makeQuery());

    expect(results[0]!.score).toBe(1.0);
  });

  it("omits records not found in store", async () => {
    searchFn = vi.fn(async () => [{ recordId: "missing-record", score: 0.9 }]);
    const engine = new LexicalRetrievalEngine(store, searchFn);
    const results = await engine.retrieve(makeQuery());
    expect(results).toHaveLength(0);
  });

  it("has name property 'lexical'", () => {
    const engine = new LexicalRetrievalEngine(store, searchFn);
    expect(engine.name).toBe("lexical");
  });

  it("passes correct opts to search function", async () => {
    let capturedOpts: { orgId: string; workspaceId: string; limit: number } = {
      orgId: "",
      workspaceId: "",
      limit: 0,
    };
    searchFn = vi.fn(
      async (
        _q: string,
        opts: { orgId: string; workspaceId: string; limit: number },
      ) => {
        capturedOpts = opts;
        return [];
      },
    );

    const engine = new LexicalRetrievalEngine(store, searchFn);
    await engine.retrieve(makeQuery({ limit: 15 }));

    expect(capturedOpts.orgId).toBe("test-org");
    expect(capturedOpts.workspaceId).toBe("test-ws");
    expect(capturedOpts.limit).toBe(15);
  });

  it("estimates token cost from body size", async () => {
    const body = { event: "log_line", payload: "x".repeat(400) };
    const record = createRecord({
      kind: "episodic",
      namespace: NS,
      body,
      salience: 0.5,
      confidence: 1.0,
      provenance: PROV,
    });
    await store.append(record);

    searchFn = vi.fn(async () => [{ recordId: record.id, score: 0.5 }]);
    const engine = new LexicalRetrievalEngine(store, searchFn);
    const results = await engine.retrieve(makeQuery());

    expect(results[0]!.tokenCost).toBeGreaterThan(50);
  });
});
