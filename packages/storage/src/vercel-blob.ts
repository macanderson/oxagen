import { put as blobPut, del as blobDel } from "@vercel/blob";
import { logger } from "./logger";
import type { GetObjectResult, PutObjectInput, PutObjectResult, StorageAdapter, StorageBody } from "./types";

/**
 * Typed error thrown when a storage key does not exist (HTTP 404 from the
 * backend). Route handlers should map this to a 404 response without leaking
 * the internal storage URL.
 */
export class StorageNotFoundError extends Error {
  readonly notFound = true as const;
  constructor(key: string) {
    super(`Storage object not found: ${key}`);
    this.name = "StorageNotFoundError";
  }
}

/**
 * Derive the public base URL for a Vercel Blob store from its read/write
 * token. Vercel Blob tokens have the format:
 *   `vercel_blob_rw_<storeId>_<secret>`
 * The storeId is the 4th underscore-separated segment (0-indexed: segment 3).
 * Public objects are served at `https://<storeId>.public.blob.vercel-storage.com`.
 *
 * Exported as a pure helper so it can be unit-tested in isolation.
 *
 * @throws {Error} When the token is empty, missing, or does not contain the
 *   expected `vercel_blob_rw_<storeId>` structure.
 */
export function publicBaseUrlFromToken(token: string): string {
  if (!token) {
    throw new Error(
      "publicBaseUrlFromToken: BLOB_READ_WRITE_TOKEN is missing. Add it to the environment to enable @oxagen/storage.",
    );
  }
  // Expected: vercel_blob_rw_<storeId>_<secret>
  // Segments (split on "_"):  [0]=vercel  [1]=blob  [2]=rw  [3]=<storeId>  [4..]=<secret parts>
  const segments = token.split("_");
  const storeId = segments[3];
  if (!storeId || segments[0] !== "vercel" || segments[1] !== "blob" || segments[2] !== "rw") {
    throw new Error(
      "publicBaseUrlFromToken: BLOB_READ_WRITE_TOKEN has an unexpected format. " +
        "Expected `vercel_blob_rw_<storeId>_<secret>`.",
    );
  }
  return `https://${storeId}.public.blob.vercel-storage.com`;
}

/** Best-effort byte length across the accepted body shapes (for instrumentation). */
function byteLength(body: StorageBody): number {
  if (body instanceof Blob) return body.size;
  if (body instanceof Uint8Array) return body.byteLength;
  return body.byteLength; // ArrayBuffer
}

/**
 * Coerce the adapter's web-standard body shapes into a type the Vercel Blob SDK
 * accepts (`PutBody`). A `Blob`/`File` passes straight through; raw bytes become
 * a Node `Buffer` (the package is server-only). Keeping this here means call
 * sites stay on the portable {@link StorageBody} union.
 */
function toPutBody(body: StorageBody): Blob | Buffer {
  if (body instanceof Blob) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(new Uint8Array(body)); // ArrayBuffer
}

/**
 * Vercel Blob driver for the storage adapter.
 *
 * Wraps `@vercel/blob` so the rest of the codebase never imports it directly.
 * The token is passed explicitly (not read implicitly from the ambient env by
 * the SDK) so the upload route can fail closed via `requireEnv` before we get
 * here. `addRandomSuffix: false` keeps keys deterministic — callers already
 * include a UUID in the key, so a second random suffix would only obscure it.
 */
export function createVercelBlobAdapter(token: string): StorageAdapter {
  // The public base URL is derived lazily on first get() call so that
  // adapters constructed for put/delete-only use cases (e.g. avatar uploads)
  // can use any token string without requiring the full vercel_blob_rw_…
  // format. The derivation is memoised after the first parse.
  let _base: string | null = null;
  function base(): string {
    if (!_base) _base = publicBaseUrlFromToken(token);
    return _base;
  }

  return {
    driver: "vercel-blob",

    async get(key: string): Promise<GetObjectResult> {
      const start = Date.now();
      // Vercel Blob public objects are served at a predictable URL derived
      // from the store ID and the object key. We fetch through fetch() so
      // the response body is a web-standard ReadableStream that can be
      // piped directly into a Response (zero-copy streaming).
      const url = `${base()}/${encodeURI(key)}`;
      const res = await fetch(url);
      if (!res.ok || !res.body) {
        logger.warn(
          { driver: "vercel-blob", key, status: res.status, durationMs: Date.now() - start },
          "storage: get — object not found or empty body",
        );
        throw new StorageNotFoundError(key);
      }
      const contentLength = res.headers.get("content-length");
      const sizeBytes = contentLength !== null ? Number(contentLength) || null : null;
      logger.info(
        { driver: "vercel-blob", key, contentType: res.headers.get("content-type"), sizeBytes, durationMs: Date.now() - start },
        "storage: object read",
      );
      return {
        body: res.body,
        contentType: res.headers.get("content-type"),
        sizeBytes,
      };
    },

    async put(input: PutObjectInput): Promise<PutObjectResult> {
      const start = Date.now();
      const bytes = byteLength(input.body);
      const result = await blobPut(input.key, toPutBody(input.body), {
        access: input.access ?? "public",
        token,
        contentType: input.contentType,
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      logger.info(
        { driver: "vercel-blob", key: input.key, contentType: input.contentType, bytes, durationMs: Date.now() - start },
        "storage: object written",
      );
      return { url: result.url, key: result.pathname, bytes };
    },

    async delete(urlOrKey: string): Promise<void> {
      const start = Date.now();
      // `del` accepts the public URL; it is a no-op for an already-absent object.
      await blobDel(urlOrKey, { token });
      logger.info(
        { driver: "vercel-blob", key: urlOrKey, durationMs: Date.now() - start },
        "storage: object deleted",
      );
    },
  };
}
