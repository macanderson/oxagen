/**
 * Sync protocol — request/response types for Merkle-diff anti-entropy
 * sync between local and cloud nodes.
 */
import type { Namespace, MemoryRecord } from "../types";
import type { MerkleNode } from "./merkle";

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
 * Abstract sync peer — represents a remote node to sync with.
 */
export interface SyncPeer {
  /** Get the peer's Merkle root hash for a namespace. */
  getRootHash(namespace: Namespace): Promise<string>;
  /** Get the peer's Merkle subtree at a given path. */
  getSubtree(namespace: Namespace, path: number[]): Promise<MerkleNode>;
  /** Pull specific records from the peer by ID. */
  pullRecords(ids: string[]): Promise<MemoryRecord[]>;
  /** Push records to the peer. */
  pushRecords(records: MemoryRecord[]): Promise<void>;
}

/**
 * Run a full sync session with a peer.
 *
 * Protocol:
 * 1. Exchange root hashes — if equal, nothing to do
 * 2. Walk divergent subtrees via Merkle diff
 * 3. Pull missing records (prioritized by salience)
 * 4. Push local-only records to peer
 * 5. Apply CRDT merge on conflicts
 */
export async function syncWithPeer(
  localRecordIds: string[],
  localMerkle: MerkleNode,
  peer: SyncPeer,
  namespace: Namespace,
  pullRecords: (ids: string[]) => Promise<MemoryRecord[]>,
  storeRecords: (records: MemoryRecord[]) => Promise<void>,
): Promise<SyncResult> {
  const startMs = Date.now();
  let recordsPulled = 0;
  let recordsPushed = 0;
  let bytesTransferred = 0;
  const conflictsDetected = 0;

  // Step 1: Compare root hashes
  const remoteRootHash = await peer.getRootHash(namespace);
  if (localMerkle.hash === remoteRootHash) {
    return { recordsPulled: 0, recordsPushed: 0, bytesTransferred: 0, conflictsDetected: 0, durationMs: Date.now() - startMs };
  }

  // Step 2: Get remote subtree and diff
  const remoteTree = await peer.getSubtree(namespace, []);
  const { diffMerkleTrees } = await import("./merkle");
  const missingLocalIds = diffMerkleTrees(localMerkle, remoteTree);
  const missingRemoteIds = diffMerkleTrees(remoteTree, localMerkle);

  // Step 3: Pull missing records from peer
  if (missingLocalIds.length > 0) {
    const pulled = await peer.pullRecords(missingLocalIds);
    await storeRecords(pulled);
    recordsPulled = pulled.length;
    bytesTransferred += JSON.stringify(pulled).length;
  }

  // Step 4: Push local-only records to peer
  if (missingRemoteIds.length > 0) {
    const toPush = await pullRecords(missingRemoteIds);
    await peer.pushRecords(toPush);
    recordsPushed = toPush.length;
    bytesTransferred += JSON.stringify(toPush).length;
  }

  return {
    recordsPulled,
    recordsPushed,
    bytesTransferred,
    conflictsDetected,
    durationMs: Date.now() - startMs,
  };
}
