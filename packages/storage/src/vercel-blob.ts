import { put as blobPut, del as blobDel, get as blobGet } from "@vercel/blob";
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
 *
 * Private blobs
 * -------------
 * When `access: "private"` is passed to `put()`, the object is stored without
 * a public CDN URL. `get()` fetches the bytes using the authenticated
 * `@vercel/blob` `get()` API (which passes the read-write token to the storage
 * plane) rather than a plain public `fetch()`. The public CDN URL is never
 * returned or persisted for private objects.
 *
 * Call sites determine access level at write time:
 *   - Avatars: access "public" (world-readable by design).
 *   - Generated images/video, workspace files: access "private" (served only
 *     through the access-controlled /api/v1/assets/[id] and /api/v1/files/[id]
 *     routes, never via a guessable CDN URL).
 */
export function createVercelBlobAdapter(token: string): StorageAdapter {
  return {
    driver: "vercel-blob",

    async get(key: string): Promise<GetObjectResult> {
      const start = Date.now();

      // We don't know the access level of an existing object from the key
      // alone. Try the authenticated SDK get() first (works for both public
      // and private blobs when we have the read-write token). Fall back to a
      // plain public fetch only when the SDK path is unavailable. Using the
      // SDK path for all gets is the safest default: it works for private blobs
      // and is no slower than a direct fetch for public ones.
      const result = await blobGet(key, { token, access: "private" });
      if (!result || !result.stream) {
        // SDK returns null for 404 (not found) or 304 (not modified).
        // Both cases surface as StorageNotFoundError to the serve route.
        logger.warn(
          { driver: "vercel-blob", key, durationMs: Date.now() - start },
          "storage: get — object not found or empty stream",
        );
        throw new StorageNotFoundError(key);
      }

      const contentType = result.blob.contentType ?? null;
      const sizeBytes = result.blob.size ?? null;

      logger.info(
        { driver: "vercel-blob", key, contentType, sizeBytes, durationMs: Date.now() - start },
        "storage: object read",
      );
      return {
        body: result.stream,
        contentType,
        sizeBytes: sizeBytes !== null && sizeBytes > 0 ? sizeBytes : null,
      };
    },

    async put(input: PutObjectInput): Promise<PutObjectResult> {
      const start = Date.now();
      const access = input.access ?? "public";
      const bytes = byteLength(input.body);
      const result = await blobPut(input.key, toPutBody(input.body), {
        access,
        token,
        contentType: input.contentType,
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      logger.info(
        { driver: "vercel-blob", key: input.key, access, contentType: input.contentType, bytes, durationMs: Date.now() - start },
        "storage: object written",
      );
      // For private blobs, result.url is the authenticated access URL (not a
      // public CDN URL). We return result.pathname as the canonical key in all
      // cases; callers must use the adapter get() to retrieve private bytes.
      return { url: result.url, key: result.pathname, bytes, access };
    },

    async delete(urlOrKey: string): Promise<void> {
      const start = Date.now();
      // `del` accepts either the URL or the pathname.
      await blobDel(urlOrKey, { token });
      logger.info(
        { driver: "vercel-blob", key: urlOrKey, durationMs: Date.now() - start },
        "storage: object deleted",
      );
    },
  };
}
