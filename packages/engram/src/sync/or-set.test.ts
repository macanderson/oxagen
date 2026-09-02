/**
 * Tests for sync/or-set.ts — serialization round-trip and tombstone GC.
 */
import { describe, it, expect } from "vitest";
import { ORSet } from "./or-set";

describe("ORSet.fromJSON", () => {
  it("round-trips exactly: fromJSON(toJSON()) reproduces toJSON()", () => {
    const set = new ORSet<string>();
    set.add("a", "n1:1");
    set.add("a", "n2:1");
    set.add("b", "n1:2");
    set.remove("b"); // tombstones n1:2

    const json = set.toJSON();
    const restored = ORSet.fromJSON(json);
    expect(restored.toJSON()).toEqual(json);
  });

  it("restored set has identical membership", () => {
    const set = new ORSet<string>();
    set.add("live", "t1");
    set.add("dead", "t2");
    set.remove("dead");

    const restored = ORSet.fromJSON(set.toJSON());
    expect(restored.has("live")).toBe(true);
    expect(restored.has("dead")).toBe(false);
    expect(restored.values()).toEqual(["live"]);
  });

  it("restored set merges identically to the original", () => {
    const a = new ORSet<string>();
    a.add("x", "a:1");
    const b = new ORSet<string>();
    b.add("y", "b:1");

    const restoredA = ORSet.fromJSON(a.toJSON());
    expect(restoredA.merge(b).values().sort()).toEqual(
      a.merge(b).values().sort(),
    );
  });
});

describe("ORSet.compact", () => {
  it("drops fully-observed tombstones and their dead entries", () => {
    const set = new ORSet<string>();
    set.add("gone", "n1:1");
    set.remove("gone"); // tombstones n1:1
    expect(set.toJSON().tombstones).toContain("n1:1");

    // Caller asserts n1:1 is below the version-vector floor (all peers saw it).
    set.compact((tag) => tag === "n1:1");

    const json = set.toJSON();
    expect(json.tombstones).toHaveLength(0);
    expect(json.entries).toHaveLength(0); // dead entry reclaimed
    expect(set.has("gone")).toBe(false); // membership unchanged
  });

  it("keeps a live tag when only some tags are GC'd", () => {
    const set = new ORSet<string>();
    set.add("fact", "n1:1");
    set.add("fact", "n2:1");
    set.remove("fact"); // tombstones both currently-observed tags... but see below

    // Re-add a concurrent tag AFTER the remove — it must survive.
    set.add("fact", "n3:1");
    // Only n1:1 and n2:1 are safely observed everywhere.
    set.compact((tag) => tag === "n1:1" || tag === "n2:1");

    expect(set.has("fact")).toBe(true); // n3:1 keeps it alive
    const entry = set.toJSON().entries.find((e) => e.value === "fact");
    expect(entry?.tags).toEqual(["n3:1"]); // dead tags reclaimed, live one kept
  });

  it("does NOT resurrect: a not-yet-observed tombstone is retained", () => {
    const a = new ORSet<string>();
    a.add("v", "n1:1");
    a.remove("v"); // tombstone n1:1

    // Conservative caller: nothing is known-observed-everywhere yet.
    a.compact(() => false);
    expect(a.toJSON().tombstones).toContain("n1:1");

    // A peer that still holds the add merges in — element stays removed.
    const peer = new ORSet<string>();
    peer.add("v", "n1:1");
    expect(a.merge(peer).has("v")).toBe(false);
  });
});
