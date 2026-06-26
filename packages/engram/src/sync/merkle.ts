/**
 * Merkle tree for efficient sync — determines which records differ between
 * two nodes by comparing tree hashes top-down.
 *
 * Transfer cost is proportional to the number of changes, not corpus size.
 */
import { createHash } from "blake3";

export interface MerkleNode {
  hash: string;
  level: number;
  children?: MerkleNode[];
  recordIds?: string[]; // Leaf nodes contain record IDs
}

/** Branching factor for the Merkle tree. Higher = shallower tree, fewer round trips. */
const FANOUT = 16;

/**
 * Build a Merkle tree over a sorted list of record IDs.
 * Records are pre-sorted by ID (content hash) for determinism.
 */
export function buildMerkleTree(recordIds: string[]): MerkleNode {
  const sorted = [...recordIds].sort();
  if (sorted.length === 0) {
    return { hash: hashLeaf("empty"), level: 0, recordIds: [] };
  }
  return buildLevel(sorted, 0);
}

function buildLevel(ids: string[], level: number): MerkleNode {
  if (ids.length <= FANOUT) {
    // Leaf node: hash all record IDs together
    const hash = hashLeaf(ids.join(":"));
    return { hash, level, recordIds: ids };
  }

  // Split into FANOUT buckets and recurse
  const bucketSize = Math.ceil(ids.length / FANOUT);
  const children: MerkleNode[] = [];
  for (let i = 0; i < ids.length; i += bucketSize) {
    const bucket = ids.slice(i, i + bucketSize);
    children.push(buildLevel(bucket, level + 1));
  }

  const hash = hashChildren(children.map((c) => c.hash));
  return { hash, level, children };
}

/**
 * Diff two Merkle trees. Returns record IDs present in `remote` but missing in `local`.
 */
export function diffMerkleTrees(local: MerkleNode, remote: MerkleNode): string[] {
  if (local.hash === remote.hash) return []; // Subtrees identical

  // If remote is a leaf, return its record IDs that aren't in local
  if (remote.recordIds) {
    const localIds = new Set(collectRecordIds(local));
    return remote.recordIds.filter((id) => !localIds.has(id));
  }

  // If local is a leaf but remote is not (different structure)
  if (local.recordIds && remote.children) {
    const localIds = new Set(local.recordIds);
    return collectRecordIds(remote).filter((id) => !localIds.has(id));
  }

  // Both have children — recurse into divergent subtrees
  const missing: string[] = [];
  const remoteChildren = remote.children ?? [];
  const localChildren = local.children ?? [];

  for (let i = 0; i < remoteChildren.length; i++) {
    const localChild = localChildren[i];
    const remoteChild = remoteChildren[i]!;

    if (!localChild) {
      // Remote has a subtree that local doesn't — all its records are missing
      missing.push(...collectRecordIds(remoteChild));
    } else if (localChild.hash !== remoteChild.hash) {
      // Subtrees differ — recurse
      missing.push(...diffMerkleTrees(localChild, remoteChild));
    }
  }

  return missing;
}

/**
 * Collect all record IDs from a Merkle subtree.
 */
export function collectRecordIds(node: MerkleNode): string[] {
  if (node.recordIds) return node.recordIds;
  if (!node.children) return [];
  return node.children.flatMap(collectRecordIds);
}

function hashLeaf(content: string): string {
  const h = createHash();
  h.update(content);
  return h.digest("hex") as string;
}

function hashChildren(childHashes: string[]): string {
  const h = createHash();
  h.update(childHashes.join(":"));
  return h.digest("hex") as string;
}
