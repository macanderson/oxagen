/**
 * hash.ts — Content hashing abstraction.
 *
 * Uses blake3 when available (CLI, API server, background workers).
 * Falls back to Node's built-in SHA-256 when blake3 native bindings
 * can't load (e.g. Next.js bundled server components on Vercel).
 *
 * The hash algorithm choice doesn't affect correctness — record IDs are
 * opaque strings. It only affects collision resistance and speed.
 * Blake3 is ~3x faster for large inputs, but SHA-256 is universally available.
 */
import { createHash as nodeCreateHash } from "node:crypto";

interface Hasher {
  update(input: string): void;
  digest(encoding: "hex"): string;
}

let _blake3CreateHash: (() => Hasher) | null | undefined = undefined;

function getBlake3(): (() => Hasher) | null {
  if (_blake3CreateHash !== undefined) return _blake3CreateHash;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const blake3 = require("blake3") as { createHash: () => Hasher };
    _blake3CreateHash = blake3.createHash;
    return _blake3CreateHash;
  } catch {
    _blake3CreateHash = null;
    return null;
  }
}

/**
 * Create a content hash. Uses blake3 if available, otherwise SHA-256.
 */
export function contentHash(input: string): string {
  const blake3Create = getBlake3();
  if (blake3Create) {
    const h = blake3Create();
    h.update(input);
    return h.digest("hex");
  }
  // Fallback: SHA-256 via Node crypto
  return nodeCreateHash("sha256").update(input).digest("hex");
}
