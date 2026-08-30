/**
 * Tests for sync/merkle.ts — stable hex-trie bucketing and metadata-aware diff.
 */
import { describe, it, expect } from "vitest";
import {
  buildMerkleTree,
  diffMerkleTrees,
  MerkleTree,
  type RecordVersion,
} from "./merkle";

/** Deterministic, well-spread 64-hex id from a seed (LCG-filled). */
function seededHexId(seed: number): string {
  let h = seed >>> 0;
  let out = "";
  while (out.length < 64) {
    h = (h * 1664525 + 1013904223) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

function versions(n: number, digest = "v1", seedBase = 0): RecordVersion[] {
  return Array.from({ length: n }, (_, i) => ({
    id: seededHexId(seedBase + i),
    versionDigest: digest,
  }));
}

/** Every (prefix → hash) pair in the trie, for locality assertions. */
function allNodeHashes(tree: MerkleTree): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (prefix: string): void => {
    const n = tree.node(prefix);
    if (!n) return;
    out.set(prefix, n.hash);
    for (const c of n.children ?? []) visit(c.prefix);
  };
  visit("");
  return out;
}

describe("MerkleTree bucketing", () => {
  it("splits past a single leaf once it exceeds the leaf cap", () => {
    const tree = buildMerkleTree(versions(60));
    expect(tree.root.leaf).toBe(false);
    expect((tree.root.children ?? []).length).toBeGreaterThan(1);
  });

  it("inserting one record changes ONLY the hashes on the path to its bucket", () => {
    const base = versions(60);
    const before = allNodeHashes(buildMerkleTree(base));

    const newRec: RecordVersion = {
      id: seededHexId(9999),
      versionDigest: "v1",
    };
    const after = allNodeHashes(buildMerkleTree([...base, newRec]));

    const changed: string[] = [];
    for (const [prefix, hash] of before) {
      const now = after.get(prefix);
      if (now !== undefined && now !== hash) changed.push(prefix);
    }

    // Every changed pre-existing node must be an ancestor of the new record...
    for (const prefix of changed) {
      expect(newRec.id.startsWith(prefix)).toBe(true);
    }
    // ...and the blast radius is tiny (root + the one bucket), not the whole tree.
    expect(changed).toContain("");
    expect(changed.length).toBeLessThan(before.size / 2);
    // Every sibling bucket the new record did NOT land in is byte-identical.
    const untouched = [...before].filter(([p]) => !newRec.id.startsWith(p));
    for (const [prefix, hash] of untouched) {
      expect(after.get(prefix)).toBe(hash);
    }
  });

  it("de-dupes duplicate ids (last version wins)", () => {
    const tree = buildMerkleTree([
      { id: "aaaa", versionDigest: "old" },
      { id: "aaaa", versionDigest: "new" },
    ]);
    const all = tree.versionsUnder("");
    expect(all).toHaveLength(1);
    expect(all[0]!.versionDigest).toBe("new");
  });
});

describe("diffMerkleTrees", () => {
  it("detects metadata-only divergence (identical id set, one changed digest)", () => {
    const base = versions(50);
    const local = buildMerkleTree(base);
    const changedId = base[13]!.id;
    const remote = buildMerkleTree(
      base.map((v) => (v.id === changedId ? { ...v, versionDigest: "v2" } : v)),
    );

    // Same ID set → old ID-only Merkle tree would have had equal roots and never converged.
    expect(local.rootHash).not.toBe(remote.rootHash);
    const diff = diffMerkleTrees(local, remote);
    expect(diff.divergent).toEqual([changedId]);
    expect(diff.remoteOnly).toEqual([]);
    expect(diff.localOnly).toEqual([]);
  });

  it("identical trees diff to empty groups", () => {
    const tree = buildMerkleTree(versions(50));
    expect(diffMerkleTrees(tree, tree)).toEqual({
      remoteOnly: [],
      localOnly: [],
      divergent: [],
    });
  });

  it("classifies remote-only, local-only, and divergent across a multi-level tree", () => {
    const base = versions(40);
    const divergentId = base[5]!.id;
    const localExtra = versions(3, "v1", 100_000); // local-only
    const remoteExtra = versions(4, "v1", 200_000); // remote-only

    const local = buildMerkleTree([
      ...base.map((v) =>
        v.id === divergentId ? { ...v, versionDigest: "L" } : v,
      ),
      ...localExtra,
    ]);
    const remote = buildMerkleTree([
      ...base.map((v) =>
        v.id === divergentId ? { ...v, versionDigest: "R" } : v,
      ),
      ...remoteExtra,
    ]);

    const diff = diffMerkleTrees(local, remote);
    expect(diff.divergent).toEqual([divergentId]);
    expect(new Set(diff.remoteOnly)).toEqual(
      new Set(remoteExtra.map((v) => v.id)),
    );
    expect(new Set(diff.localOnly)).toEqual(
      new Set(localExtra.map((v) => v.id)),
    );
  });
});
