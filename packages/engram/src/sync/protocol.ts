/**
 * Sync protocol — Merkle-diff anti-entropy between a local replica and a peer.
 *
 * The exchange is proportional to the *divergence*, not the corpus size:
 *   1. Exchange root hashes — if equal, stop (one round trip, no subtree fetch).
 *   2. Descend the Merkle trie, fetching a peer subtree ONLY where a child hash
 *      differs, until divergence is localized to leaf boundaries.
 *   3. At each diverged boundary, classify records into remote-only, local-only,
 *      and divergent (same id, different metadata digest).
 *   4. Pull remote-only + divergent records; merge them into the local set with
 *      CRDT metadata rules (sync/merge.ts); push local-only + divergent records
 *      so the peer converges symmetrically.
 */
import type { Namespace, MemoryRecord } from "../types";
import type {
  MerkleNode,
  MerkleChildRef,
  MerkleDiff,
  RecordVersion,
} from "./merkle";
import { MerkleTree, compareVersions } from "./merkle";
import { mergeRecordSets } from "./merge";

export interface SyncRequest {
  type: "root_hash" | "subtree_diff" | "pull_records" | "push_records";
  namespace: Namespace;
  payload: unknown;
}

export interface SyncResponse {
  type: "root_hash" | "diff_result" | "records" | "ack";
  payload: unknown;
}

export interface SyncResult {
  recordsPulled: number;
  recordsPushed: number;
  bytesTransferred: number;
  conflictsDetected: number;
  durationMs: number;
}

/**
 * Abstract sync peer — a remote replica addressed by Merkle prefix.
 */
export interface SyncPeer {
  /** The peer's Merkle root hash for a namespace. */
  getRootHash(namespace: Namespace): Promise<string>;
  /**
   * The peer's shallow Merkle node at a hex `prefix` (`""` = root), or undefined
   * if no record shares that prefix. Shallow = children carry hashes only, so
   * the caller descends by requesting child prefixes where hashes differ.
   */
  getSubtree(
    namespace: Namespace,
    prefix: string,
  ): Promise<MerkleNode | undefined>;
  /** Pull specific records from the peer by ID. */
  pullRecords(ids: string[]): Promise<MemoryRecord[]>;
  /** Push records to the peer. */
  pushRecords(records: MemoryRecord[]): Promise<void>;
}

/**
 * Run a full anti-entropy sync session with a peer.
 *
 * @param localTree    Local Merkle trie over `{id, versionDigest}` (see merkle.ts).
 * @param peer         Remote replica.
 * @param namespace    Tenant/session scope being synced.
 * @param loadLocal    Load local records by ID (for merge + push).
 * @param storeRecords Persist merged records locally.
 */
export async function syncWithPeer(
  localTree: MerkleTree,
  peer: SyncPeer,
  namespace: Namespace,
  loadLocal: (ids: string[]) => Promise<MemoryRecord[]>,
  storeRecords: (records: MemoryRecord[]) => Promise<void>,
): Promise<SyncResult> {
  const startMs = Date.now();
  const empty: SyncResult = {
    recordsPulled: 0,
    recordsPushed: 0,
    bytesTransferred: 0,
    conflictsDetected: 0,
    durationMs: 0,
  };

  // Step 1: root hashes. Equal → replicas already converged, one round trip.
  const remoteRootHash = await peer.getRootHash(namespace);
  if (localTree.rootHash === remoteRootHash) {
    return { ...empty, durationMs: Date.now() - startMs };
  }

  // Step 2: descend the trie, fetching remote subtrees only where hashes differ.
  const diff: MerkleDiff = { remoteOnly: [], localOnly: [], divergent: [] };
  const rootRemote = await peer.getSubtree(namespace, "");
  await walk("", localTree.node(""), rootRemote);

  // Step 3: pull remote-only + divergent, merge, store.
  const idsToPull = [...diff.remoteOnly, ...diff.divergent];
  const pulled = idsToPull.length ? await peer.pullRecords(idsToPull) : [];
  const localDivergent = diff.divergent.length
    ? await loadLocal(diff.divergent)
    : [];
  const merged = mergeRecordSets(localDivergent, pulled);
  if (merged.merged.length) await storeRecords(merged.merged);

  // Step 4: push local-only + divergent so the peer converges too.
  const idsToPush = [...diff.localOnly, ...diff.divergent];
  const toPush = idsToPush.length ? await loadLocal(idsToPush) : [];
  if (toPush.length) await peer.pushRecords(toPush);

  const bytesTransferred =
    (pulled.length ? JSON.stringify(pulled).length : 0) +
    (toPush.length ? JSON.stringify(toPush).length : 0);

  return {
    recordsPulled: pulled.length,
    recordsPushed: toPush.length,
    bytesTransferred,
    conflictsDetected: merged.conflicts.length,
    durationMs: Date.now() - startMs,
  };

  async function walk(
    prefix: string,
    lNode: MerkleNode | undefined,
    rNode: MerkleNode | undefined,
  ): Promise<void> {
    if (!lNode && !rNode) return;
    if (lNode && rNode && lNode.hash === rNode.hash) return; // identical subtree
    if (!lNode) {
      for (const v of await collectRemote(rNode!)) diff.remoteOnly.push(v.id);
      return;
    }
    if (!rNode) {
      for (const v of localTree.versionsUnder(prefix))
        diff.localOnly.push(v.id);
      return;
    }
    // Both present, hashes differ.
    if (lNode.leaf || rNode.leaf) {
      compareVersions(
        localTree.versionsUnder(prefix),
        await collectRemote(rNode),
        diff,
      );
      return;
    }
    // Both internal: recurse ONLY into children whose hashes differ.
    const lChildren = new Map<string, MerkleChildRef>(
      (lNode.children ?? []).map((c) => [c.key, c]),
    );
    const rChildren = new Map<string, MerkleChildRef>(
      (rNode.children ?? []).map((c) => [c.key, c]),
    );
    const keys = new Set<string>([...lChildren.keys(), ...rChildren.keys()]);
    for (const key of [...keys].sort()) {
      const lc = lChildren.get(key);
      const rc = rChildren.get(key);
      if (lc && rc && lc.hash === rc.hash) continue; // identical child — no fetch
      const childPrefix = prefix + key;
      const rChild = rc
        ? await peer.getSubtree(namespace, childPrefix)
        : undefined;
      await walk(childPrefix, localTree.node(childPrefix), rChild);
    }
  }

  async function collectRemote(node: MerkleNode): Promise<RecordVersion[]> {
    if (node.leaf) return node.leaves ?? [];
    const out: RecordVersion[] = [];
    for (const ref of node.children ?? []) {
      const child = await peer.getSubtree(namespace, ref.prefix);
      if (child) out.push(...(await collectRemote(child)));
    }
    return out;
  }
}
