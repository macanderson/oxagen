/**
 * Integration test for the nightly consolidation pipeline against a real
 * DuckDB store — the end-to-end proof that the job actually distills, evicts
 * TTL-expired records, and is idempotent on re-run.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createStore,
  createRecord,
  type EpisodicStore,
  type Namespace,
  type EpisodicBody,
} from "@oxagen/engram";
import { consolidateWorkspace } from "./engram.consolidation.impl";

const NS: Namespace = { org: "cons-org", workspace: "cons-ws" };
const PROV = { author: "seed", derivedFrom: [] as string[], timestamp: 1_700_000_000_000 };

function episodic(
  body: EpisodicBody,
  createdAt: number,
  opts: { ttl?: number; causality?: string[] } = {},
) {
  return createRecord({
    kind: "episodic",
    namespace: NS,
    body,
    salience: 0.5,
    confidence: 1,
    provenance: PROV,
    causality: opts.causality,
    ttl: opts.ttl,
    createdAt,
  });
}

describe("consolidateWorkspace", () => {
  let store: EpisodicStore;
  const now = 1_700_000_100_000;
  const since = now - 24 * 60 * 60 * 1000;

  beforeEach(() => {
    store = createStore({ adapter: "duckdb", duckdbPath: ":memory:" });
  });
  afterEach(async () => {
    await store.close();
  });

  it("distills facts, evicts TTL-expired records, and is idempotent", async () => {
    // Three similar successful tool calls in the window → a distilled fact.
    for (let i = 0; i < 3; i++) {
      await store.append(
        episodic({ event: "tool_call", payload: { tool: "grep" }, outcome: "success" }, now - 3600_000 + i),
      );
    }
    // An expired record (ttl in the past) that must actually be evicted.
    const expired = episodic(
      { event: "stale", payload: {}, outcome: "unknown" },
      now - 7200_000,
      { ttl: now - 1000 },
    );
    await store.append(expired);

    const first = await consolidateWorkspace(store, NS, { now, since });

    expect(first.newFacts).toBeGreaterThan(0);
    expect(first.evicted).toBeGreaterThanOrEqual(1);
    // The expired record is really gone, not just flagged.
    expect(await store.getById(expired.id)).toBeNull();

    // A distilled semantic fact now exists.
    const facts = await store.query({ namespace: NS, kinds: ["semantic"], limit: 100 });
    expect(facts.length).toBeGreaterThan(0);

    // Second run over the same events: deterministic identity means the fact is
    // matched (boosted), not duplicated, and there's nothing left to evict.
    const second = await consolidateWorkspace(store, NS, { now, since });
    expect(second.newFacts).toBe(0);
    expect(second.evicted).toBe(0);

    const factsAfter = await store.query({ namespace: NS, kinds: ["semantic"], limit: 100 });
    expect(factsAfter.length).toBe(facts.length);
  });

  it("reconciles salience from stored outcomes without compounding on re-run", async () => {
    // A fact referenced by successful episodic events should be reinforced once.
    const fact = createRecord({
      kind: "semantic",
      namespace: NS,
      body: { fact: "grep finds code", domain: "tooling" },
      salience: 0.5,
      confidence: 0.6,
      provenance: PROV,
      createdAt: now - 3600_000,
    });
    await store.append(fact);
    for (let i = 0; i < 3; i++) {
      await store.append(
        episodic(
          { event: "observation", payload: {}, outcome: "success" },
          now - 1800_000 + i,
          { causality: [fact.id] },
        ),
      );
    }

    const first = await consolidateWorkspace(store, NS, { now, since });
    expect(first.reinforced).toBeGreaterThanOrEqual(1);
    const afterFirst = (await store.getById(fact.id))!.salience;

    // The next nightly run's window contains no new outcome events (the daily
    // window doesn't overlap the ones already consolidated), so reinforcement
    // has nothing to reconcile and salience is stable.
    const second = await consolidateWorkspace(store, NS, { now, since: now });
    expect(second.reinforced).toBe(0);
    expect((await store.getById(fact.id))!.salience).toBeCloseTo(afterFirst, 10);
  });

  it("returns a namespace via listNamespaces once records exist", async () => {
    await store.append(episodic({ event: "e", payload: {}, outcome: "unknown" }, now));
    const namespaces = await store.listNamespaces();
    expect(namespaces).toContainEqual({ org: NS.org, workspace: NS.workspace });
  });
});
