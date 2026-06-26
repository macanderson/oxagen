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

interface Blake3Like {
  createHash: () => {
    update(input: string): void;
    digest(encoding: "hex"): string;
  };
}

let _blake3: Blake3Like | null | undefined = undefined;

/**
 * Eagerly initialize blake3. Call once at process start (daemon, CLI, API bootstrap).
 * After this resolves, contentHash() uses blake3 synchronously.
 */
export async function initHash(): Promise<void> {
  if (_blake3 !== undefined) return;
  try {
    const mod = (await import("blake3")) as unknown as Blake3Like;
    _blake3 = mod;
  } catch {
    _blake3 = null;
  }
}

/**
 * Create a content hash. Uses blake3 if already loaded via initHash(),
 * otherwise falls back to SHA-256 (always available, no native deps).
 */
export function contentHash(input: string): string {
  if (_blake3) {
    const h = _blake3.createHash();
    h.update(input);
    return h.digest("hex");
  }
  // Fallback: SHA-256 via Node crypto
  return nodeCreateHash("sha256").update(input).digest("hex");
}
