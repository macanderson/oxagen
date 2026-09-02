import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DuckDBEpisodicStore } from "./duckdb-adapter";
import { createRecord } from "../record";
import type { EpisodicBody, Namespace, Provenance } from "../types";

const namespace: Namespace = { org: "test-org", workspace: "test-ws" };
const provenance: Provenance = {
  author: "test-agent",
  derivedFrom: [],
  timestamp: Date.now(),
};

function makeRecord(event: string, payload: unknown = {}) {
  const body: EpisodicBody = { event, payload };
  return createRecord({
    kind: "episodic",
    namespace,
    body,
    salience: 0.5,
    confidence: 1.0,
    provenance,
  });
}

describe("DuckDBEpisodicStore", () => {
  let store: DuckDBEpisodicStore;

  beforeEach(() => {
    store = new DuckDBEpisodicStore({ path: ":memory:" });
  });

  afterEach(async () => {
    await store.close();
  });

  it("appends and retrieves a record by ID", async () => {
    const record = makeRecord("tool_call", { name: "grep" });
    await store.append(record);

    const retrieved = await store.getById(record.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(record.id);
    expect(retrieved!.kind).toBe("episodic");
    expect(retrieved!.body).toEqual(record.body);
  });

  it("deduplicates by content-addressed ID", async () => {
    const record = makeRecord("dedup_test", { x: 1 });
    await store.append(record);
    await store.append(record); // Same content → same ID → no duplicate

    const results = await store.query({ namespace, limit: 100 });
    const matching = results.filter((r) => r.id === record.id);
    expect(matching).toHaveLength(1);
  });

  it("queries with namespace scoping", async () => {
    const r1 = makeRecord("event-a");
    const r2 = createRecord({
      kind: "episodic",
      namespace: { org: "other-org", workspace: "other-ws" },
      body: { event: "event-b", payload: {} },
      salience: 0.5,
      confidence: 1.0,
      provenance,
    });

    await store.append(r1);
    await store.append(r2);

    const results = await store.query({ namespace, limit: 100 });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(r1.id);
  });

  it("queries with temporal filters", async () => {
    const now = Date.now();
    const oldRecord = {
      ...makeRecord("old-event"),
      createdAt: now - 10000,
    };
    const newRecord = {
      ...makeRecord("new-event"),
      createdAt: now,
    };

    await store.append(oldRecord);
    await store.append(newRecord);

    const results = await store.query({
      namespace,
      after: now - 5000,
      limit: 100,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.body).toEqual({ event: "new-event", payload: {} });
  });

  it("queries with kind filter", async () => {
    const episodic = makeRecord("ep");
    const semantic = createRecord({
      kind: "semantic",
      namespace,
      body: { fact: "test fact", domain: "test" },
      salience: 0.5,
      confidence: 0.9,
      provenance,
    });

    await store.append(episodic);
    await store.append(semantic);

    const results = await store.query({
      namespace,
      kinds: ["semantic"],
      limit: 100,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("semantic");
  });

  it("queries with minimum salience filter", async () => {
    const lowSalience = createRecord({
      kind: "episodic",
      namespace,
      body: { event: "low", payload: {} },
      salience: 0.2,
      confidence: 1.0,
      provenance,
    });
    const highSalience = createRecord({
      kind: "episodic",
      namespace,
      body: { event: "high", payload: {} },
      salience: 0.8,
      confidence: 1.0,
      provenance,
    });

    await store.append(lowSalience);
    await store.append(highSalience);

    const results = await store.query({
      namespace,
      minSalience: 0.5,
      limit: 100,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.salience).toBe(0.8);
  });

  it("appendBatch writes multiple records", async () => {
    const records = [
      makeRecord("batch-1"),
      makeRecord("batch-2"),
      makeRecord("batch-3"),
    ];
    await store.appendBatch(records);

    const results = await store.query({ namespace, limit: 100 });
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  it("getByIds returns all found records", async () => {
    const r1 = makeRecord("multi-1");
    const r2 = makeRecord("multi-2");
    await store.appendBatch([r1, r2]);

    const results = await store.getByIds([r1.id, r2.id, "nonexistent"]);
    expect(results).toHaveLength(2);
  });

  it("recent returns records ordered by createdAt DESC", async () => {
    const r1 = { ...makeRecord("first"), createdAt: 1000 };
    const r2 = { ...makeRecord("second"), createdAt: 2000 };
    const r3 = { ...makeRecord("third"), createdAt: 3000 };

    await store.appendBatch([r1, r2, r3]);

    const results = await store.recent(namespace, 2);
    expect(results).toHaveLength(2);
    expect(results[0]!.createdAt).toBeGreaterThanOrEqual(results[1]!.createdAt);
  });

  describe("searchLexical", () => {
    it("finds a record by an exact substring match (case-insensitive)", async () => {
      const record = makeRecord("error_observed", {
        message: "NullPointerException thrown at auth.ts:42",
      });
      await store.append(record);

      const results = await store.searchLexical(
        namespace,
        "nullpointerexception auth.ts:42",
        10,
      );
      expect(results).toHaveLength(1);
      expect(results[0]!.recordId).toBe(record.id);
      expect(results[0]!.score).toBeGreaterThan(0);
    });

    it("scores by fraction of matched tokens", async () => {
      const record = makeRecord("error_observed", {
        message: "auth.ts:42 failure",
      });
      await store.append(record);

      // Only 1 of the 2 tokens matches ("nonexistentterm" never appears).
      const results = await store.searchLexical(
        namespace,
        "auth.ts:42 nonexistentterm",
        10,
      );
      expect(results).toHaveLength(1);
      expect(results[0]!.score).toBeCloseTo(0.5, 5);
    });

    it("returns no results when nothing matches", async () => {
      await store.append(makeRecord("unrelated", { message: "all good here" }));
      const results = await store.searchLexical(
        namespace,
        "totally different query",
        10,
      );
      expect(results).toHaveLength(0);
    });

    it("scopes results to the given namespace", async () => {
      const record = makeRecord("error_observed", {
        message: "shared error text",
      });
      await store.append(record);
      await store.append(
        createRecord({
          kind: "episodic",
          namespace: { org: "other-org", workspace: "other-ws" },
          body: {
            event: "error_observed",
            payload: { message: "shared error text" },
          },
          salience: 0.5,
          confidence: 1.0,
          provenance,
        }),
      );

      const results = await store.searchLexical(
        namespace,
        "shared error text",
        10,
      );
      expect(results).toHaveLength(1);
      expect(results[0]!.recordId).toBe(record.id);
    });

    it("returns an empty array when the query has no usable tokens", async () => {
      await store.append(makeRecord("event", { message: "content" }));
      const results = await store.searchLexical(namespace, "a . : -", 10);
      expect(results).toHaveLength(0);
    });

    it("respects the limit", async () => {
      await store.appendBatch([
        makeRecord("e1", { message: "shared token alpha" }),
        makeRecord("e2", { message: "shared token beta" }),
        makeRecord("e3", { message: "shared token gamma" }),
      ]);

      const results = await store.searchLexical(namespace, "shared token", 2);
      expect(results).toHaveLength(2);
    });
  });
});
