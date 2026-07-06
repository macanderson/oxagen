/**
 * hash.ts — Content hashing for record IDs.
 *
 * Uses Node's built-in SHA-256 unconditionally. Content addressing REQUIRES a
 * single, environment-independent algorithm: the record ID is derived from the
 * content, so if the CLI hashed with blake3 while the bundled Vercel server
 * fell back to SHA-256 (blake3's native bindings don't load under esbuild),
 * identical content produced *different* IDs on the two surfaces — silently
 * defeating dedup and cross-surface record identity.
 *
 * SHA-256 is available everywhere with no native dependency, so it is the fixed
 * choice. Speed is a non-issue for the small inputs we hash (kind + namespace +
 * body); collision resistance is far more than we need for content addressing.
 */
import { createHash as nodeCreateHash } from "node:crypto";

/**
 * Retained for API compatibility. Hashing no longer requires any async
 * initialization (SHA-256 is synchronous and always available), so this is a
 * no-op that callers may still invoke at startup without effect.
 */
export async function initHash(): Promise<void> {
  // Intentionally empty — SHA-256 needs no initialization. See module docs.
}

/**
 * Create a content hash (SHA-256, hex). Deterministic and identical across
 * every environment (CLI, bundled server, worker).
 */
export function contentHash(input: string): string {
  return nodeCreateHash("sha256").update(input).digest("hex");
}
