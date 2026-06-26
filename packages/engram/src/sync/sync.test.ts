import { describe, it, expect } from "vitest";
import { tick, mergeClock, compareClock, generateTag } from "./crdt";
import { ORSet } from "./or-set";
import { PNCounter } from "./pn-counter";
import { mergeRecordSets } from "./merge";
import { buildMerkleTree, diffMerkleTrees } from "./merkle";
import { prioritizeForSync } from "./priority";
import { createRecord } from "../record";
import type { Namespace } from "../types";

const NS: Namespace = { org: "org", workspace: "ws" };
const PROV = { author: "test", derivedFrom: [] as string[], timestamp: Date.now() };

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
    // node-a positive: max(3, 2) = 3
    // node-b positive: max(0, 4) = 4
    // node-b negative: max(1, 0) = 1
    expect(merged.value()).toBe(3 + 4 - 1); // 6
  });

  it("merge is commutative", () => {
    const a = new PNCounter();
    a.increment("x", 5);
    const b = new PNCounter();
    b.increment("y", 3);
    expect(a.merge(b).value()).toBe(b.merge(a).value());
  });
});

describe("mergeRecordSets", () => {
  it("union of non-overlapping sets includes all records", () => {
    const local = [createRecord({ kind: "episodic", namespace: NS, body: { event: "a", payload: {} }, salience: 0.5, confidence: 1, provenance: PROV })];
    const remote = [createRecord({ kind: "episodic", namespace: NS, body: { event: "b", payload: {} }, salience: 0.5, confidence: 1, provenance: PROV })];
    const result = mergeRecordSets(local, remote);
    expect(result.merged).toHaveLength(2);
    expect(result.newFromRemote).toHaveLength(1);
  });

  it("same record in both: takes max salience", () => {
    const record = createRecord({ kind: "semantic", namespace: NS, body: { fact: "x", domain: "t" }, salience: 0.5, confidence: 0.8, provenance: PROV });
    const local = [{ ...record, salience: 0.3 }];
    const remote = [{ ...record, salience: 0.9 }];
    const result = mergeRecordSets(local, remote);
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0]!.salience).toBe(0.9);
  });
});

describe("Merkle tree", () => {
  it("identical sets produce identical root hashes", () => {
    const ids = ["aaa", "bbb", "ccc"];
    const tree1 = buildMerkleTree(ids);
    const tree2 = buildMerkleTree(ids);
    expect(tree1.hash).toBe(tree2.hash);
  });

  it("different sets produce different root hashes", () => {
    const tree1 = buildMerkleTree(["aaa", "bbb"]);
    const tree2 = buildMerkleTree(["aaa", "ccc"]);
    expect(tree1.hash).not.toBe(tree2.hash);
  });

  it("diff finds records in remote but not local", () => {
    const local = buildMerkleTree(["aaa", "bbb"]);
    const remote = buildMerkleTree(["aaa", "bbb", "ccc"]);
    const missing = diffMerkleTrees(local, remote);
    expect(missing).toContain("ccc");
    expect(missing).not.toContain("aaa");
  });

  it("diff returns empty for identical trees", () => {
    const tree = buildMerkleTree(["a", "b", "c"]);
    expect(diffMerkleTrees(tree, tree)).toEqual([]);
  });
});

describe("prioritizeForSync", () => {
  it("sorts by salience descending", () => {
    const records = [
      createRecord({ kind: "episodic", namespace: NS, body: { event: "low", payload: {} }, salience: 0.2, confidence: 1, provenance: PROV }),
      createRecord({ kind: "semantic", namespace: NS, body: { fact: "high", domain: "t" }, salience: 0.9, confidence: 1, provenance: PROV }),
    ];
    const sorted = prioritizeForSync(records);
    expect(sorted[0]!.salience).toBeGreaterThan(sorted[1]!.salience);
  });
});
