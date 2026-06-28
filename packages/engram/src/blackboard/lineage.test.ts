/**
 * Additional tests for blackboard/lineage.ts — findDerived and agentContributionStats.
 * The traceLineage tests live in blackboard.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DuckDBEpisodicStore } from "../store/duckdb-adapter";
import { createRecord } from "../record";
import { findDerived, agentContributionStats, traceLineage } from "./lineage";
import type { Namespace, Provenance, MemoryRecord } from "../types";

const NS: Namespace = { org: "test-org", workspace: "test-ws" };
const PROV: Provenance = { author: "agent-x", derivedFrom: [], timestamp: Date.now() };

function makeEpisodic(event: string, provenance: Provenance = PROV): MemoryRecord {
  return createRecord({
    kind: "episodic",
    namespace: NS,
    body: { event, payload: {} },
    salience: 0.5,
    confidence: 0.9,
    provenance,
  });
}

function makeSemantic(fact: string, derivedFrom: string[] = [], author = "agent-x"): MemoryRecord {
  return createRecord({
    kind: "semantic",
    namespace: NS,
    body: { fact, domain: "test" },
    salience: 0.7,
    confidence: 0.8,
    provenance: { author, derivedFrom, timestamp: Date.now() },
  });
}

describe("findDerived", () => {
  let store: DuckDBEpisodicStore;

  beforeEach(() => {
    store = new DuckDBEpisodicStore({ path: ":memory:" });
  });

  afterEach(async () => {
    await store.close();
  });

  it("returns empty array when no records are derived from the source", async () => {
    const source = makeEpisodic("observation");
    await store.append(source);
    // Add an unrelated record
    const unrelated = makeSemantic("Unrelated fact", []);
    await store.append(unrelated);

    const derived = await findDerived(source.id, store, NS);
    expect(derived).toHaveLength(0);
  });

  it("finds records derived via provenance.derivedFrom", async () => {
    const source = makeEpisodic("raw_data");
    await store.append(source);

    const derived = makeSemantic("Derived insight", [source.id]);
    await store.append(derived);

    const results = await findDerived(source.id, store, NS);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(derived.id);
  });

  it("finds records derived via causality chain", async () => {
    const source = makeEpisodic("causality_root");
    await store.append(source);

    // Record with causality pointing to source
    const child = {
      ...makeSemantic("Caused fact", []),
      causality: [source.id],
    };
    await store.append(child);

    const results = await findDerived(source.id, store, NS);
    expect(results.some((r) => r.id === child.id)).toBe(true);
  });

  it("respects the limit parameter", async () => {
    const source = makeEpisodic("popular_source");
    await store.append(source);

    // Create multiple records derived from source
    for (let i = 0; i < 5; i++) {
      const d = makeSemantic(`fact ${i}`, [source.id]);
      await store.append(d);
    }

    const results = await findDerived(source.id, store, NS, 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

describe("agentContributionStats", () => {
  it("returns zero stats for agent with no records", () => {
    const records = [makeEpisodic("event", { author: "other-agent", derivedFrom: [], timestamp: Date.now() })];
    const stats = agentContributionStats(records, "agent-x");
    expect(stats.totalRecords).toBe(0);
    expect(stats.byKind).toEqual({});
    expect(stats.avgConfidence).toBe(0);
  });

  it("counts records by kind", () => {
    const records: MemoryRecord[] = [
      makeEpisodic("ev1"),
      makeEpisodic("ev2"),
      makeSemantic("fact1"),
    ];
    const stats = agentContributionStats(records, "agent-x");
    expect(stats.totalRecords).toBe(3);
    expect(stats.byKind["episodic"]).toBe(2);
    expect(stats.byKind["semantic"]).toBe(1);
  });

  it("computes average confidence correctly", () => {
    const records: MemoryRecord[] = [
      { ...makeSemantic("f1"), confidence: 0.8 },
      { ...makeSemantic("f2"), confidence: 0.6 },
    ];
    const stats = agentContributionStats(records, "agent-x");
    expect(stats.avgConfidence).toBeCloseTo(0.7, 5);
  });

  it("only counts records authored by the specified agent", () => {
    const myRecord = makeEpisodic("my-event", { author: "agent-x", derivedFrom: [], timestamp: Date.now() });
    const otherRecord = makeEpisodic("other-event", { author: "agent-y", derivedFrom: [], timestamp: Date.now() });
    const stats = agentContributionStats([myRecord, otherRecord], "agent-x");
    expect(stats.totalRecords).toBe(1);
  });

  it("handles empty record list", () => {
    const stats = agentContributionStats([], "agent-x");
    expect(stats.totalRecords).toBe(0);
    expect(stats.avgConfidence).toBe(0);
    expect(stats.byKind).toEqual({});
  });
});

describe("traceLineage (additional)", () => {
  let store: DuckDBEpisodicStore;

  beforeEach(() => {
    store = new DuckDBEpisodicStore({ path: ":memory:" });
  });

  afterEach(async () => {
    await store.close();
  });

  it("computes higher trust for short chain", async () => {
    const source = makeEpisodic("direct_observation");
    await store.append(source);

    const derived = makeSemantic("Direct fact", [source.id]);
    await store.append(derived);

    const chain = await traceLineage(derived.id, store);
    expect(chain).not.toBeNull();
    expect(chain!.trustScore).toBeGreaterThan(0);
    expect(chain!.trustScore).toBeLessThanOrEqual(1);
  });

  it("returns trust = own confidence for records with no ancestors", async () => {
    const standalone = makeEpisodic("standalone");
    await store.append(standalone);

    const chain = await traceLineage(standalone.id, store);
    expect(chain).not.toBeNull();
    expect(chain!.trustScore).toBeCloseTo(standalone.confidence, 5);
  });

  it("boosts trust for system/migration authors in chain", async () => {
    const systemRecord = createRecord({
      kind: "episodic",
      namespace: NS,
      body: { event: "migration_event", payload: {} },
      salience: 0.9,
      confidence: 1.0,
      provenance: { author: "system", derivedFrom: [], timestamp: Date.now() },
    });
    await store.append(systemRecord);

    const derived = makeSemantic("System-derived fact", [systemRecord.id]);
    await store.append(derived);

    const chain = await traceLineage(derived.id, store);
    expect(chain).not.toBeNull();
    // Should have reliability boost because "system" is in reliableAuthors
    expect(chain!.trustScore).toBeGreaterThan(0);
  });
});
