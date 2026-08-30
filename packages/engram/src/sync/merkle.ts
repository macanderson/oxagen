/**
 * Merkle trie for efficient anti-entropy sync — determines which records differ
 * between two replicas by comparing subtree hashes top-down, descending only
 * into diverging subtrees so transfer cost is proportional to the number of
 * changes, not corpus size.
 *
 * Two properties this structure guarantees, both of which the previous
 * ID-set-only tree lacked:
 *
 *  1. **Metadata-aware.** A leaf hashes each record's `{id, versionDigest}`, so
 *     two replicas with identical ID sets but divergent metadata (salience,
 *     confidence, causality — see sync/merge.ts `recordVersionDigest`) get
 *     different hashes and are reconciled instead of silently diverging.
 *
 *  2. **Stable bucketing.** Records are bucketed by a **stable hex prefix of
 *     their ID** (a radix-16 trie), never by array index. Inserting or mutating
 *     one record changes only the O(depth) hashes on the path from its leaf to
 *     the root; every sibling subtree hash is byte-identical. Index-based
 *     bucketing shifted every boundary on a single insert, causing false
 *     divergence and near-full re-pulls.
 */
import { contentHash } from "../hash";
import { canonicalStringify } from "../canonical-json";

/** A record's identity paired with a digest of its mergeable metadata. */
export interface RecordVersion {
  /** Content-addressed record ID (hex). */
  id: string;
  /** Digest of mergeable metadata — see sync/merge.ts `recordVersionDigest`. */
  versionDigest: string;
}

/** A reference to an immediate child subtree (hash only — no nested payload). */
export interface MerkleChildRef {
  /** Single hex character branching at this node's depth. */
  key: string;
  /** Full hex prefix of the child subtree (`this.prefix + key`). */
  prefix: string;
  /** Root hash of the child subtree. */
  hash: string;
}

/**
 * One node of the trie, in the shallow form exchanged over the wire: a leaf
 * carries its record versions; an internal node carries only its immediate
 * children's hashes (not their nested contents), so exchanging a node is O(fanout),
 * and a peer descends by requesting child prefixes only where hashes differ.
 */
export interface MerkleNode {
  hash: string;
  /** Hex prefix this node covers (`""` = root). */
  prefix: string;
  leaf: boolean;
  /** Present iff `leaf`: record versions in this bucket, sorted by id. */
  leaves?: RecordVersion[];
  /** Present iff not `leaf`: immediate children, sorted by key. */
  children?: MerkleChildRef[];
}

/** Result of diffing two tries: record IDs grouped by which side must act. */
export interface MerkleDiff {
  /** Present in remote, absent locally → pull. */
  remoteOnly: string[];
  /** Present locally, absent in remote → push. */
  localOnly: string[];
  /** Present on both with differing versionDigest → pull + merge + push. */
  divergent: string[];
}

/**
 * A bucket holding at most this many versions is a leaf; a larger bucket splits
 * by the next hex character of the ID (radix-16 trie), so the fanout is 16.
 */
const LEAF_MAX = 16;

/**
 * A fully-materialized local trie. Holds every node indexed by prefix so any
 * subtree can be served in shallow form (`node`) or fully collected
 * (`versionsUnder`) without rebuilding.
 */
export class MerkleTree {
  private constructor(
    private readonly rootNode: MerkleNode,
    private readonly byPrefix: Map<string, MerkleNode>,
  ) {}

  static build(versions: RecordVersion[]): MerkleTree {
    // De-dupe by id (last wins) so a caller passing the same id twice can't
    // produce two leaves for one record.
    const uniq = new Map<string, RecordVersion>();
    for (const v of versions) uniq.set(v.id, v);
    const byPrefix = new Map<string, MerkleNode>();
    const root = buildNode("", [...uniq.values()], byPrefix);
    return new MerkleTree(root, byPrefix);
  }

  get root(): MerkleNode {
    return this.rootNode;
  }

  get rootHash(): string {
    return this.rootNode.hash;
  }

  /** Shallow node at `prefix`, or undefined if no records share that prefix. */
  node(prefix: string): MerkleNode | undefined {
    return this.byPrefix.get(prefix);
  }

  /** Every record version under `prefix` (`""` = whole tree), sorted by id. */
  versionsUnder(prefix = ""): RecordVersion[] {
    const node = this.byPrefix.get(prefix);
    if (!node) return [];
    return collectVersions(node, this.byPrefix);
  }
}

function buildNode(
  prefix: string,
  versions: RecordVersion[],
  byPrefix: Map<string, MerkleNode>,
): MerkleNode {
  // Leaf: small enough, or we've exhausted the ID's hex characters.
  if (versions.length <= LEAF_MAX || prefix.length >= 64) {
    const leaves = [...versions].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const node: MerkleNode = {
      hash: hashLeaf(leaves),
      prefix,
      leaf: true,
      leaves,
    };
    byPrefix.set(prefix, node);
    return node;
  }

  // Internal: bucket by the hex character at this depth.
  const buckets = new Map<string, RecordVersion[]>();
  for (const v of versions) {
    const key = v.id[prefix.length] ?? "0";
    const bucket = buckets.get(key);
    if (bucket) bucket.push(v);
    else buckets.set(key, [v]);
  }

  const children: MerkleChildRef[] = [];
  for (const key of [...buckets.keys()].sort()) {
    const child = buildNode(prefix + key, buckets.get(key)!, byPrefix);
    children.push({ key, prefix: child.prefix, hash: child.hash });
  }

  const node: MerkleNode = {
    hash: hashChildren(children),
    prefix,
    leaf: false,
    children,
  };
  byPrefix.set(prefix, node);
  return node;
}

function collectVersions(
  node: MerkleNode,
  byPrefix: Map<string, MerkleNode>,
): RecordVersion[] {
  if (node.leaf) return node.leaves ?? [];
  const out: RecordVersion[] = [];
  for (const ref of node.children ?? []) {
    const child = byPrefix.get(ref.prefix);
    if (child) out.push(...collectVersions(child, byPrefix));
  }
  return out;
}

/**
 * Convenience wrapper: build a trie directly over record versions.
 * (Kept as a free function so callers don't need to reference the class.)
 */
export function buildMerkleTree(versions: RecordVersion[]): MerkleTree {
  return MerkleTree.build(versions);
}

/**
 * Diff two fully-materialized local tries, descending only into subtrees whose
 * hashes differ. Returns record IDs grouped by which side must act. Identical
 * tries return empty groups after inspecting only the root.
 */
export function diffMerkleTrees(
  local: MerkleTree,
  remote: MerkleTree,
): MerkleDiff {
  const diff: MerkleDiff = { remoteOnly: [], localOnly: [], divergent: [] };
  walk("");
  return diff;

  function walk(prefix: string): void {
    const l = local.node(prefix);
    const r = remote.node(prefix);
    if (!l && !r) return;
    if (l && r && l.hash === r.hash) return; // identical subtree — skip entirely
    if (!l) {
      for (const v of remote.versionsUnder(prefix)) diff.remoteOnly.push(v.id);
      return;
    }
    if (!r) {
      for (const v of local.versionsUnder(prefix)) diff.localOnly.push(v.id);
      return;
    }
    // Both present, hashes differ.
    if (l.leaf || r.leaf) {
      compareVersions(
        local.versionsUnder(prefix),
        remote.versionsUnder(prefix),
        diff,
      );
      return;
    }
    // Both internal: recurse only into children whose keys exist on either side.
    const keys = new Set<string>();
    for (const c of l.children ?? []) keys.add(c.key);
    for (const c of r.children ?? []) keys.add(c.key);
    for (const key of [...keys].sort()) walk(prefix + key);
  }
}

/** Classify two version sets (from a diverged leaf boundary) into the diff. */
export function compareVersions(
  local: RecordVersion[],
  remote: RecordVersion[],
  diff: MerkleDiff,
): void {
  const lMap = new Map(local.map((v) => [v.id, v.versionDigest]));
  const rMap = new Map(remote.map((v) => [v.id, v.versionDigest]));
  for (const [id, digest] of rMap) {
    if (!lMap.has(id)) diff.remoteOnly.push(id);
    else if (lMap.get(id) !== digest) diff.divergent.push(id);
  }
  for (const [id] of lMap) if (!rMap.has(id)) diff.localOnly.push(id);
}

function hashLeaf(leaves: RecordVersion[]): string {
  return contentHash(
    "leaf:" + canonicalStringify(leaves.map((v) => [v.id, v.versionDigest])),
  );
}

function hashChildren(children: MerkleChildRef[]): string {
  return contentHash(
    "node:" + canonicalStringify(children.map((c) => [c.key, c.hash])),
  );
}
