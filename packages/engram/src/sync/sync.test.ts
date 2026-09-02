import { describe, it, expect } from "vitest";
import { tick, mergeClock, compareClock } from "./crdt";
import { ORSet } from "./or-set";
import { PNCounter } from "./pn-counter";
import { mergeRecordSets, toRecordVersion } from "./merge";
import { buildMerkleTree, diffMerkleTrees } from "./merkle";
import { prioritizeForSync } from "./priority";
import { createRecord } from "../record";
import type { Namespace } from "../types";

const NS: Namespace = { org: "org", workspace: "ws" };
const PROV = {
  author: "test",
  derivedFrom: [] as string[],
  timestamp: Date.now(),
};

describe("VectorClock", () => {
  it("tick increments a node's counter", () => {
    const clock = tick({}, "node-a");
    expect(clock["node-a"]).toBe(1);
    const clock2 = tick(clock, "node-a");
    expect(clock2["node-a"]).toBe(2);
  });

  it("mergeClock takes point-wise max", () => {
    const a = { "node-a": 3, "node-b": 1 };
    const b = { "node-a": 2, "node-b": 4, "node-c": 1 };
    const merged = mergeClock(a, b);
    expect(merged).toEqual({ "node-a": 3, "node-b": 4, "node-c": 1 });
  });

  it("compareClock detects concurrent writes", () => {
    expect(compareClock({ a: 2, b: 1 }, { a: 1, b: 2 })).toBe("concurrent");
    expect(compareClock({ a: 2 }, { a: 1 })).toBe("after");
    expect(compareClock({ a: 1 }, { a: 2 })).toBe("before");
    expect(compareClock({ a: 1 }, { a: 1 })).toBe("equal");
  });
});

describe("ORSet", () => {
  it("add makes element present", () => {
    const set = new ORSet<string>();
    set.add("hello", "tag-1");
    expect(set.has("hello")).toBe(true);
    expect(set.size).toBe(1);
  });

  it("remove makes element absent", () => {
    const set = new ORSet<string>();
    set.add("hello", "tag-1");
    set.remove("hello");
    expect(set.has("hello")).toBe(false);
  });

  it("concurrent add survives remove (add-wins)", () => {
    const set = new ORSet<string>();
    set.add("hello", "tag-1");
    set.remove("hello"); // tombstones tag-1
    set.add("hello", "tag-2"); // concurrent add with different tag
    expect(set.has("hello")).toBe(true); // tag-2 is not tombstoned
  });

  it("merge is commutative", () => {
    const a = new ORSet<string>();
    a.add("x", "a:1");
    const b = new ORSet<string>();
    b.add("y", "b:1");

    const ab = a.merge(b);
    const ba = b.merge(a);
    expect(ab.values().sort()).toEqual(ba.values().sort());
  });

  it("merge preserves concurrent adds through remove", () => {
    const a = new ORSet<string>();
    a.add("fact", "a:1");
    const b = new ORSet<string>();
    b.add("fact", "b:1");
    a.remove("fact"); // a removes its own tag

    const merged = a.merge(b);
    // b's tag survives a's remove (a only tombstoned "a:1", not "b:1")
    expect(merged.has("fact")).toBe(true);
  });

  it("structurally-equal object values collapse onto one entry (canonical id)", () => {
    const set = new ORSet<{ a: number; b: number }>();
    set.add({ a: 1, b: 2 }, "t1");
    // Same value, keys in different order — must be the SAME element.
    set.add({ b: 2, a: 1 }, "t2");
    expect(set.size).toBe(1);
    set.remove({ b: 2, a: 1 });
    expect(set.has({ a: 1, b: 2 })).toBe(false);
  });
});

describe("PNCounter", () => {
  it("increments and decrements correctly", () => {
    const counter = new PNCounter();
    counter.increment("node-a", 5);
    counter.decrement("node-a", 2);
    expect(counter.value()).toBe(3);
  });

  it("merge takes point-wise max", () => {
    const a = new PNCounter();
    a.increment("node-a", 3);
    a.decrement("node-b", 1);

    const b = new PNCounter();
    b.increment("node-a", 2);
    b.increment("node-b", 4);

    const merged = a.merge(b);
    expect(merged.value()).toBe(3 + 4 - 1); // 6
  });

  it("merge is commutative", () => {
    const a = new PNCounter();
    a.increment("x", 5);
    const b = new PNCounter();
    b.increment("y", 3);
    expect(a.merge(b).value()).toBe(b.merge(a).value());
  });

  it("rejects negative and non-finite amounts (grow-only invariant)", () => {
    const c = new PNCounter();
    expect(() => c.increment("n", -1)).toThrow(RangeError);
    expect(() => c.decrement("n", -1)).toThrow(RangeError);
    expect(() => c.increment("n", Number.NaN)).toThrow(RangeError);
    expect(() => c.increment("n", Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
    // Zero is a permitted no-op.
    expect(() => c.increment("n", 0)).not.toThrow();
  });
});

describe("mergeRecordSets", () => {
  it("union of non-overlapping sets includes all records", () => {
    const local = [
      createRecord({
        kind: "episodic",
        namespace: NS,
        body: { event: "a", payload: {} },
        salience: 0.5,
        confidence: 1,
        provenance: PROV,
      }),
    ];
    const remote = [
      createRecord({
        kind: "episodic",
        namespace: NS,
        body: { event: "b", payload: {} },
        salience: 0.5,
        confidence: 1,
        provenance: PROV,
      }),
    ];
    const result = mergeRecordSets(local, remote);
    expect(result.merged).toHaveLength(2);
    expect(result.newFromRemote).toHaveLength(1);
  });

  it("same record in both: takes max salience and confidence", () => {
    const record = createRecord({
      kind: "semantic",
      namespace: NS,
      body: { fact: "x", domain: "t" },
      salience: 0.5,
      confidence: 0.8,
      provenance: PROV,
    });
    const local = [{ ...record, salience: 0.3, confidence: 0.4 }];
    const remote = [{ ...record, salience: 0.9, confidence: 0.6 }];
    const result = mergeRecordSets(local, remote);
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0]!.salience).toBe(0.9);
    expect(result.merged[0]!.confidence).toBe(0.6);
  });

  it("unions causality edges deterministically", () => {
    const record = createRecord({
      kind: "semantic",
      namespace: NS,
      body: { fact: "y", domain: "t" },
      salience: 0.5,
      confidence: 0.5,
      provenance: PROV,
    });
    const local = [{ ...record, causality: ["b", "a"] }];
    const remote = [{ ...record, causality: ["c", "a"] }];
    const result = mergeRecordSets(local, remote);
    expect(result.merged[0]!.causality).toEqual(["a", "b", "c"]);
  });
});

describe("Merkle tree", () => {
  it("identical version sets produce identical root hashes (order-independent)", () => {
    const vs = [
      { id: "aaa", versionDigest: "v1" },
      { id: "bbb", versionDigest: "v1" },
      { id: "ccc", versionDigest: "v1" },
    ];
    expect(buildMerkleTree(vs).rootHash).toBe(
      buildMerkleTree([...vs].reverse()).rootHash,
    );
  });

  it("different id sets produce different root hashes", () => {
    const t1 = buildMerkleTree([
      { id: "aaa", versionDigest: "v1" },
      { id: "bbb", versionDigest: "v1" },
    ]);
    const t2 = buildMerkleTree([
      { id: "aaa", versionDigest: "v1" },
      { id: "ccc", versionDigest: "v1" },
    ]);
    expect(t1.rootHash).not.toBe(t2.rootHash);
  });

  it("diff finds records in remote but not local", () => {
    const local = buildMerkleTree([
      { id: "aaa", versionDigest: "v1" },
      { id: "bbb", versionDigest: "v1" },
    ]);
    const remote = buildMerkleTree([
      { id: "aaa", versionDigest: "v1" },
      { id: "bbb", versionDigest: "v1" },
      { id: "ccc", versionDigest: "v1" },
    ]);
    const diff = diffMerkleTrees(local, remote);
    expect(diff.remoteOnly).toContain("ccc");
    expect(diff.remoteOnly).not.toContain("aaa");
    expect(diff.divergent).toEqual([]);
  });

  it("diff returns empty groups for identical trees", () => {
    const tree = buildMerkleTree([
      { id: "a", versionDigest: "v1" },
      { id: "b", versionDigest: "v1" },
    ]);
    expect(diffMerkleTrees(tree, tree)).toEqual({
      remoteOnly: [],
      localOnly: [],
      divergent: [],
    });
  });

  it("toRecordVersion digests real records by mergeable metadata", () => {
    const r = createRecord({
      kind: "semantic",
      namespace: NS,
      body: { fact: "z", domain: "t" },
      salience: 0.5,
      confidence: 0.5,
      provenance: PROV,
    });
    expect(toRecordVersion(r).id).toBe(r.id);
    expect(toRecordVersion({ ...r, salience: 0.9 }).versionDigest).not.toBe(
      toRecordVersion(r).versionDigest,
    );
  });
});

describe("prioritizeForSync", () => {
  it("sorts by salience descending", () => {
    const records = [
      createRecord({
        kind: "episodic",
        namespace: NS,
        body: { event: "low", payload: {} },
        salience: 0.2,
        confidence: 1,
        provenance: PROV,
      }),
      createRecord({
        kind: "semantic",
        namespace: NS,
        body: { fact: "high", domain: "t" },
        salience: 0.9,
        confidence: 1,
        provenance: PROV,
      }),
    ];
    const sorted = prioritizeForSync(records);
    expect(sorted[0]!.salience).toBeGreaterThan(sorted[1]!.salience);
  });
});
