/**
 * Property-based convergence tests for the CRDTs in sync/.
 *
 * State-based CRDTs must have a merge that is commutative, associative, and
 * idempotent — that is what guarantees replicas converge no matter the order or
 * grouping in which updates propagate. These are deterministic loops over a
 * seeded PRNG (no external dep), so failures reproduce exactly.
 */
import { describe, it, expect } from "vitest";
import { ORSet } from "./or-set";
import { PNCounter } from "./pn-counter";
import { mergeRecordSets } from "./merge";
import { createRecord } from "../record";
import type { MemoryRecord, Namespace } from "../types";

const NS: Namespace = { org: "org", workspace: "ws" };
const PROV = { author: "test", derivedFrom: [] as string[], timestamp: 1 };
const SEEDS = Array.from({ length: 25 }, (_, i) => i * 2654435761);

/** mulberry32 — tiny deterministic PRNG. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: T[]): T =>
  xs[Math.floor(r() * xs.length)]!;

// --------------------------------------------------------------------------
// ORSet
// --------------------------------------------------------------------------

function normalizeORSet<T>(set: ORSet<T>): string {
  const j = set.toJSON();
  const entries = j.entries
    .map((e) => ({ value: e.value, tags: [...e.tags].sort() }))
    .sort((a, b) =>
      JSON.stringify(a.value).localeCompare(JSON.stringify(b.value)),
    );
  return JSON.stringify({ entries, tombstones: [...j.tombstones].sort() });
}

function randomORSet(
  r: () => number,
  node: string,
  ops: number,
): ORSet<string> {
  const set = new ORSet<string>();
  const vals = ["a", "b", "c", "d", "e"];
  let clock = 0;
  for (let i = 0; i < ops; i++) {
    const v = pick(r, vals);
    if (r() < 0.7) set.add(v, `${node}:${clock++}`);
    else set.remove(v);
  }
  return set;
}

describe("ORSet convergence properties", () => {
  it("merge is commutative, associative, and idempotent", () => {
    for (const seed of SEEDS) {
      const r = rng(seed);
      const a = randomORSet(r, "a", 12);
      const b = randomORSet(r, "b", 12);
      const c = randomORSet(r, "c", 12);

      expect(normalizeORSet(a.merge(b))).toBe(normalizeORSet(b.merge(a)));
      expect(normalizeORSet(a.merge(b).merge(c))).toBe(
        normalizeORSet(a.merge(b.merge(c))),
      );
      expect(normalizeORSet(a.merge(a))).toBe(normalizeORSet(a));
    }
  });
});

// --------------------------------------------------------------------------
// PNCounter
// --------------------------------------------------------------------------

function normalizePN(c: PNCounter): string {
  const j = c.toJSON();
  const sortObj = (o: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(o).sort(([x], [y]) => x.localeCompare(y)),
    );
  return JSON.stringify({
    positive: sortObj(j.positive),
    negative: sortObj(j.negative),
  });
}

function randomPN(r: () => number, ops: number): PNCounter {
  const c = new PNCounter();
  const nodes = ["n1", "n2", "n3"];
  for (let i = 0; i < ops; i++) {
    const amt = Math.floor(r() * 5); // grow-only: >= 0
    if (r() < 0.5) c.increment(pick(r, nodes), amt);
    else c.decrement(pick(r, nodes), amt);
  }
  return c;
}

describe("PNCounter convergence properties", () => {
  it("merge is commutative, associative, and idempotent", () => {
    for (const seed of SEEDS) {
      const r = rng(seed);
      const a = randomPN(r, 15);
      const b = randomPN(r, 15);
      const c = randomPN(r, 15);

      expect(normalizePN(a.merge(b))).toBe(normalizePN(b.merge(a)));
      expect(normalizePN(a.merge(b).merge(c))).toBe(
        normalizePN(a.merge(b.merge(c))),
      );
      expect(normalizePN(a.merge(a))).toBe(normalizePN(a));
      // Value is order-independent too.
      expect(a.merge(b).value()).toBe(b.merge(a).value());
    }
  });
});

// --------------------------------------------------------------------------
// mergeRecordSets
// --------------------------------------------------------------------------

const BASE_RECORDS: MemoryRecord[] = Array.from({ length: 6 }, (_, i) =>
  createRecord({
    kind: "semantic",
    namespace: NS,
    body: { fact: `f-${i}`, domain: "t" },
    salience: 0.5,
    confidence: 0.5,
    provenance: PROV,
  }),
);

function normalizeRecords(records: MemoryRecord[]): string {
  return JSON.stringify(
    records
      .map((r) => ({
        id: r.id,
        salience: r.salience,
        confidence: r.confidence,
        causality: [...r.causality].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

function randomRecordSet(r: () => number): MemoryRecord[] {
  const out: MemoryRecord[] = [];
  for (const base of BASE_RECORDS) {
    if (r() < 0.5) continue; // each replica holds a random subset
    out.push({
      ...base,
      salience: Math.floor(r() * 11) / 10,
      confidence: Math.floor(r() * 11) / 10,
      causality: r() < 0.5 ? ["x", "y"] : ["y", "z"],
    });
  }
  return out;
}

const mergeAll = (x: MemoryRecord[], y: MemoryRecord[]): MemoryRecord[] =>
  mergeRecordSets(x, y).merged;

describe("mergeRecordSets convergence properties", () => {
  it("merge is commutative, associative, and idempotent", () => {
    for (const seed of SEEDS) {
      const r = rng(seed);
      const a = randomRecordSet(r);
      const b = randomRecordSet(r);
      const c = randomRecordSet(r);

      expect(normalizeRecords(mergeAll(a, b))).toBe(
        normalizeRecords(mergeAll(b, a)),
      );
      expect(normalizeRecords(mergeAll(mergeAll(a, b), c))).toBe(
        normalizeRecords(mergeAll(a, mergeAll(b, c))),
      );
      expect(normalizeRecords(mergeAll(a, a))).toBe(normalizeRecords(a));
    }
  });
});
