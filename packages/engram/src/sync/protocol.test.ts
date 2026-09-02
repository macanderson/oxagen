/**
 * Tests for sync/protocol.ts — syncWithPeer anti-entropy.
 */
import { describe, it, expect, vi } from "vitest";
import { syncWithPeer, type SyncPeer } from "./protocol";
import { buildMerkleTree, MerkleTree } from "./merkle";
import { toRecordVersion } from "./merge";
import { createRecord } from "../record";
import type { Namespace, Provenance, MemoryRecord } from "../types";

const NS: Namespace = { org: "test-org", workspace: "test-ws" };
const PROV: Provenance = {
  author: "test",
  derivedFrom: [],
  timestamp: Date.now(),
};

function makeRecord(event: string, salience = 0.5): MemoryRecord {
  return createRecord({
    kind: "episodic",
    namespace: NS,
    body: { event, payload: {} },
    salience,
    confidence: 1.0,
    provenance: PROV,
  });
}

function treeOf(records: MemoryRecord[]): MerkleTree {
  return buildMerkleTree(records.map(toRecordVersion));
}

/**
 * In-memory peer backed by a record store + Merkle trie, with spies on every
 * method so tests can assert how much of the tree was actually exchanged.
 */
function makePeer(records: MemoryRecord[]) {
  const store = new Map(records.map((r) => [r.id, r]));
  const rebuild = () =>
    buildMerkleTree([...store.values()].map(toRecordVersion));
  let tree = rebuild();
  const getSubtree = vi.fn(async (_ns: Namespace, prefix: string) =>
    tree.node(prefix),
  );
  const peer: SyncPeer = {
    getRootHash: vi.fn(async () => tree.rootHash),
    getSubtree,
    pullRecords: vi.fn(async (ids: string[]) =>
      ids.map((id) => store.get(id)).filter((r): r is MemoryRecord => !!r),
    ),
    pushRecords: vi.fn(async (recs: MemoryRecord[]) => {
      for (const r of recs) store.set(r.id, r);
      tree = rebuild();
    }),
  };
  return { peer, store, getSubtree };
}

/** Local side helpers: load/store against an in-memory map. */
function makeLocal(records: MemoryRecord[]) {
  const store = new Map(records.map((r) => [r.id, r]));
  const loadLocal = vi.fn(async (ids: string[]) =>
    ids.map((id) => store.get(id)).filter((r): r is MemoryRecord => !!r),
  );
  const storeRecords = vi.fn(async (recs: MemoryRecord[]) => {
    for (const r of recs) store.set(r.id, r);
  });
  return { store, loadLocal, storeRecords };
}

describe("syncWithPeer", () => {
  it("returns zero counts and fetches no subtree when roots match", async () => {
    const shared = [makeRecord("a"), makeRecord("b")];
    const { peer, getSubtree } = makePeer(shared);
    const { loadLocal, storeRecords } = makeLocal(shared);

    const result = await syncWithPeer(
      treeOf(shared),
      peer,
      NS,
      loadLocal,
      storeRecords,
    );

    expect(result.recordsPulled).toBe(0);
    expect(result.recordsPushed).toBe(0);
    expect(result.bytesTransferred).toBe(0);
    expect(getSubtree).not.toHaveBeenCalled(); // O(1): only the root hash was exchanged
  });

  it("pulls records present in remote but not local and stores them", async () => {
    const shared = makeRecord("shared");
    const remoteOnly = makeRecord("remote-only");
    const { peer } = makePeer([shared, remoteOnly]);
    const { store, loadLocal, storeRecords } = makeLocal([shared]);

    const result = await syncWithPeer(
      treeOf([shared]),
      peer,
      NS,
      loadLocal,
      storeRecords,
    );

    expect(result.recordsPulled).toBe(1);
    expect(storeRecords).toHaveBeenCalled();
    expect(store.has(remoteOnly.id)).toBe(true);
    expect(result.bytesTransferred).toBeGreaterThan(0);
  });

  it("pushes records present in local but not remote", async () => {
    const shared = makeRecord("shared");
    const localOnly = makeRecord("local-only");
    const { peer, store: remoteStore } = makePeer([shared]);
    const { loadLocal, storeRecords } = makeLocal([shared, localOnly]);

    const result = await syncWithPeer(
      treeOf([shared, localOnly]),
      peer,
      NS,
      loadLocal,
      storeRecords,
    );

    expect(result.recordsPushed).toBe(1);
    expect(peer.pushRecords).toHaveBeenCalled();
    expect(remoteStore.has(localOnly.id)).toBe(true);
  });

  it("handles both pull and push in the same sync", async () => {
    const shared = makeRecord("shared");
    const localOnly = makeRecord("local-only");
    const remoteOnly = makeRecord("remote-only");
    const { peer } = makePeer([shared, remoteOnly]);
    const { loadLocal, storeRecords } = makeLocal([shared, localOnly]);

    const result = await syncWithPeer(
      treeOf([shared, localOnly]),
      peer,
      NS,
      loadLocal,
      storeRecords,
    );

    expect(result.recordsPulled).toBe(1);
    expect(result.recordsPushed).toBe(1);
  });

  it("converges on metadata-only divergence (same id, different salience)", async () => {
    // Same content-addressed id on both sides, but salience differs → the record
    // is detected as divergent (via versionDigest), pulled, merged (max wins),
    // stored locally, and pushed so the peer converges too.
    const base = makeRecord("boosted", 0.3);
    const remoteVersion = { ...base, salience: 0.9 };
    const localVersion = { ...base, salience: 0.3 };

    const { peer, store: remoteStore } = makePeer([remoteVersion]);
    const {
      store: localStore,
      loadLocal,
      storeRecords,
    } = makeLocal([localVersion]);

    const result = await syncWithPeer(
      treeOf([localVersion]),
      peer,
      NS,
      loadLocal,
      storeRecords,
    );

    // Local converged to the max salience.
    expect(localStore.get(base.id)!.salience).toBe(0.9);
    // Peer received our version and will merge to the same max on its side.
    expect(peer.pushRecords).toHaveBeenCalled();
    expect(remoteStore.has(base.id)).toBe(true);
    expect(result.conflictsDetected).toBe(1); // |0.9-0.3| > 0.2
  });

  it("fetches only the divergent record's subtree path, not the whole tree", async () => {
    // Enough records to force the trie to split past a single leaf.
    const shared = Array.from({ length: 40 }, (_, i) =>
      makeRecord(`rec-${i}`, 0.5),
    );
    const divergentId = shared[7]!.id;
    const localVersions = shared.map((r) =>
      r.id === divergentId ? { ...r, salience: 0.2 } : r,
    );
    const remoteVersions = shared.map((r) =>
      r.id === divergentId ? { ...r, salience: 0.8 } : r,
    );

    const { peer, getSubtree } = makePeer(remoteVersions);
    const { loadLocal, storeRecords } = makeLocal(localVersions);

    const result = await syncWithPeer(
      treeOf(localVersions),
      peer,
      NS,
      loadLocal,
      storeRecords,
    );

    // Only the one divergent record is pulled...
    expect(peer.pullRecords).toHaveBeenCalledWith([divergentId]);
    expect(result.recordsPulled).toBe(1);
    // ...and the descent touched far fewer subtree nodes than the corpus size.
    expect(getSubtree.mock.calls.length).toBeGreaterThan(0);
    expect(getSubtree.mock.calls.length).toBeLessThan(shared.length);
  });

  it("records duration in the result", async () => {
    const shared = [makeRecord("x")];
    const { peer } = makePeer(shared);
    const { loadLocal, storeRecords } = makeLocal(shared);
    const result = await syncWithPeer(
      treeOf(shared),
      peer,
      NS,
      loadLocal,
      storeRecords,
    );
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("full bidirectional sync leaves both replicas with identical roots", async () => {
    const shared = makeRecord("shared");
    const localOnly = makeRecord("local-only");
    const remoteOnly = makeRecord("remote-only");
    const { peer, store: remoteStore } = makePeer([shared, remoteOnly]);
    const {
      store: localStore,
      loadLocal,
      storeRecords,
    } = makeLocal([shared, localOnly]);

    await syncWithPeer(
      treeOf([shared, localOnly]),
      peer,
      NS,
      loadLocal,
      storeRecords,
    );

    const localRoot = buildMerkleTree(
      [...localStore.values()].map(toRecordVersion),
    ).rootHash;
    const remoteRoot = buildMerkleTree(
      [...remoteStore.values()].map(toRecordVersion),
    ).rootHash;
    expect(localRoot).toBe(remoteRoot);
  });
});
