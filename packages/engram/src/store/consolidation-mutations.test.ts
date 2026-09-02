/**
 * Tests for the consolidation-only store mutations added for PR 2:
 * listNamespaces, updateSalience, updateConfidence, evictExpired (TTL).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DuckDBEpisodicStore } from "./duckdb-adapter";
import { createRecord } from "../record";
import type { Namespace, Provenance } from "../types";

const PROV: Provenance = {
  author: "t",
  derivedFrom: [],
  timestamp: 1_700_000_000_000,
};

function fact(
  ns: Namespace,
  text: string,
  opts: { ttl?: number; createdAt?: number } = {},
) {
  return createRecord({
    kind: "semantic",
    namespace: ns,
    body: { fact: text, domain: "d" },
    salience: 0.5,
    confidence: 0.5,
    provenance: PROV,
    ttl: opts.ttl,
    createdAt: opts.createdAt ?? 1_700_000_000_000,
  });
}

describe("DuckDB consolidation mutations", () => {
  let store: DuckDBEpisodicStore;
  const NS: Namespace = { org: "o", workspace: "w" };

  beforeEach(() => {
    store = new DuckDBEpisodicStore({ path: ":memory:" });
  });
  afterEach(async () => {
    await store.close();
  });

  it("lists distinct namespaces with records", async () => {
    await store.append(fact({ org: "o1", workspace: "w1" }, "a"));
    await store.append(fact({ org: "o1", workspace: "w1" }, "b"));
    await store.append(fact({ org: "o2", workspace: "w2" }, "c"));
    const ns = await store.listNamespaces();
    expect(ns).toContainEqual({ org: "o1", workspace: "w1" });
    expect(ns).toContainEqual({ org: "o2", workspace: "w2" });
    expect(ns).toHaveLength(2);
  });

  it("updates salience in place without changing the id", async () => {
    const r = fact(NS, "reinforce me");
    await store.append(r);
    await store.updateSalience(r.id, 0.92);
    const got = await store.getById(r.id);
    expect(got!.id).toBe(r.id);
    expect(got!.salience).toBeCloseTo(0.92, 6);
  });

  it("updates confidence in place", async () => {
    const r = fact(NS, "boost confidence");
    await store.append(r);
    await store.updateConfidence(r.id, 0.99);
    expect((await store.getById(r.id))!.confidence).toBeCloseTo(0.99, 6);
  });

  it("evicts only TTL-expired records and returns the count", async () => {
    const now = 1_700_000_100_000;
    const expired = fact(NS, "expired", { ttl: now - 1 });
    const future = fact(NS, "future", { ttl: now + 60_000 });
    const noTtl = fact(NS, "no ttl");
    await store.append(expired);
    await store.append(future);
    await store.append(noTtl);

    const evicted = await store.evictExpired(NS, now);
    expect(evicted).toBe(1);
    expect(await store.getById(expired.id)).toBeNull();
    expect(await store.getById(future.id)).not.toBeNull();
    expect(await store.getById(noTtl.id)).not.toBeNull();
  });

  it("evictExpired is a no-op when nothing has expired", async () => {
    const now = 1_700_000_100_000;
    await store.append(fact(NS, "fresh", { ttl: now + 1000 }));
    expect(await store.evictExpired(NS, now)).toBe(0);
  });
});
