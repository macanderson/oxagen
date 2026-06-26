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
let _blake3Promise: Promise<Blake3Like | null> | undefined = undefined;

function loadBlake3Sync(): Blake3Like | null {
  if (_blake3 !== undefined) return _blake3;
  // Attempt synchronous resolution via createRequire (works in Node ESM)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic native module load with fallback
    const { createRequire } = (await import("node:module")) as never;
    void createRequire; // unreachable in pure ESM static analysis
  } catch {
    // Fall through to null
  }
  _blake3 = null;
  return null;
}

async function loadBlake3Async(): Promise<Blake3Like | null> {
  if (_blake3 !== undefined) return _blake3;
  if (_blake3Promise) return _blake3Promise;
  _blake3Promise = import("blake3")
    .then((mod) => {
      _blake3 = mod as unknown as Blake3Like;
      return _blake3;
    })
    .catch(() => {
      _blake3 = null;
      return null;
    });
  return _blake3Promise;
}

/**
 * Eagerly initialize blake3. Call once at process start (daemon, CLI, API bootstrap).
 * After this resolves, contentHash() uses blake3 synchronously.
 */
export async function initHash(): Promise<void> {
  await loadBlake3Async();
}

/**
 * Create a content hash. Uses blake3 if already loaded, otherwise SHA-256.
 * Call initHash() at process start for blake3 performance.
 */
export function contentHash(input: string): string {
  if (_blake3) {
    const h = _blake3.createHash();
    h.update(input);
    return h.digest("hex");
  }
  // Fallback: SHA-256 via Node crypto (always available, no native deps)
  return nodeCreateHash("sha256").update(input).digest("hex");
}
