/**
 * RFC 6962 Merkle tree hash over an ordered list of frame digests (Mission
 * Control spec §8.3: the seal computes one hash that commits to every frame
 * hash). Leaves are the frames' own `sha256:` digests in sequence order.
 *
 *   MTH({})        = SHA-256()
 *   MTH({d0})      = SHA-256(0x00 || d0)
 *   MTH(D[n])      = SHA-256(0x01 || MTH(D[0:k]) || MTH(D[k:n]))
 *
 * where k is the largest power of two strictly less than n. Domain separation
 * (0x00 for a leaf, 0x01 for a node) is what keeps a second-preimage attack
 * from presenting a node as a leaf. The leaf input is the raw 32 digest
 * bytes, so a verifier holding the frame digests recomputes the same root
 * from an export without this code.
 */
import { createHash } from "node:crypto";
import { SHA256_DIGEST_PATTERN, type Sha256Digest } from "../digest";

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

function digestToBytes(digest: string): Buffer {
  if (!SHA256_DIGEST_PATTERN.test(digest)) {
    throw new TypeError(`not a sha256 digest: ${digest}`);
  }
  return Buffer.from(digest.slice("sha256:".length), "hex");
}

function hash(...parts: readonly Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const part of parts) h.update(part);
  return h.digest();
}

function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function treeHash(leaves: readonly Buffer[]): Buffer {
  if (leaves.length === 0) return hash();
  if (leaves.length === 1) return hash(LEAF_PREFIX, leaves[0] as Buffer);
  const k = largestPowerOfTwoBelow(leaves.length);
  return hash(
    NODE_PREFIX,
    treeHash(leaves.slice(0, k)),
    treeHash(leaves.slice(k)),
  );
}

/** The Merkle root over frame digests in sequence order, as `sha256:<hex>`. */
export function merkleRoot(digests: readonly string[]): Sha256Digest {
  const leaves = digests.map(digestToBytes);
  return `sha256:${treeHash(leaves).toString("hex")}`;
}
