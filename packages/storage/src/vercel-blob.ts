import { put as blobPut, del as blobDel, get as blobGet } from "@vercel/blob";
import { StorageNotFoundError } from "./errors";
import { logger } from "./logger";
import type {
  GetObjectResult,
  PutObjectInput,
  PutObjectResult,
  StorageAdapter,
  StorageBody,
} from "./types";

export { StorageNotFoundError } from "./errors";

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
  if (
    !storeId ||
    segments[0] !== "vercel" ||
    segments[1] !== "blob" ||
    segments[2] !== "rw"
  ) {
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
 * accepts (`PutBody`). A `Blob`/`File` and a `Buffer` pass straight through.
 * Other raw bytes become a `Buffer` view over the same memory, never a copy:
 * a copy doubles each upload's footprint on a 256 MB API heap (#4202). The
 * package is server-only. Keeping this here means call sites stay on the
 * portable {@link StorageBody} union.
 */
function toPutBody(body: StorageBody): Blob | Buffer {
  if (body instanceof Blob) return body;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  return Buffer.from(body); // ArrayBuffer: a view, not a copy
}

/** The refusal a public-only store answers to `access: "private"`. */
function isPrivateAccessRefusal(err: unknown): boolean {
  return (
    err instanceof Error && err.message.includes("Cannot use private access")
  );
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
 *
 * Public-only stores
 * ------------------
 * A store provisioned public-only refuses `access: "private"` on every call.
 * The adapter learns that from the first refusal, on a read or a write, and
 * sends every later call straight to public access. Before, each private write
 * uploaded its bytes twice, and each private read asked twice (#4202). The
 * flag lives in this closure. `storage()` memoizes one adapter per process,
 * so the store's answer is remembered for the process's life.
 */
export function createVercelBlobAdapter(token: string): StorageAdapter {
  let publicOnly = false;

  function learnPublicOnly(key: string): void {
    if (publicOnly) return;
    publicOnly = true;
    // Once per process: every later downgrade shows as `requestedAccess:
    // "private"` beside `access: "public"` on the write log instead.
    logger.warn(
      {
        driver: "vercel-blob",
        key,
        reason: "store is public-only; private blobs are stored as public",
      },
      "storage: store refused private access; later calls use public access",
    );
  }

  return {
    driver: "vercel-blob",

    async get(key: string): Promise<GetObjectResult> {
      const start = Date.now();

      // Try the authenticated SDK get() first — it is the only path that can
      // read a private blob, and it also reads public blobs on a store that
      // has private access enabled. A store provisioned public-only rejects
      // `access: "private"` outright, so that one error is caught below and
      // retried as public, and every later read goes to public directly.
      const result = publicOnly
        ? await blobGet(key, { token, access: "public" })
        : await blobGet(key, { token, access: "private" }).catch(
            async (err: unknown) => {
              if (!isPrivateAccessRefusal(err)) throw err;
              learnPublicOnly(key);
              return blobGet(key, { token, access: "public" });
            },
          );

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
        {
          driver: "vercel-blob",
          key,
          contentType,
          sizeBytes,
          durationMs: Date.now() - start,
        },
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

      // The access level the blob is ACTUALLY written with. On a public-only
      // store a requested "private" put falls back to "public"; we must report
      // the real visibility so callers persist accurate metadata and never
      // treat a world-readable blob as access-controlled.
      let effectiveAccess: "public" | "private" = publicOnly ? "public" : access;
      // Converted once: a refused private attempt retries with the same bytes.
      const body = toPutBody(input.body);
      const send = (level: "public" | "private") =>
        blobPut(input.key, body, {
          access: level,
          token,
          contentType: input.contentType,
          addRandomSuffix: false,
          allowOverwrite: true,
        });

      const result = await send(effectiveAccess).catch(
        async (err: unknown) => {
          if (effectiveAccess !== "private" || !isPrivateAccessRefusal(err)) {
            throw err;
          }
          // The store is public-only, so the blob is stored world-readable.
          effectiveAccess = "public";
          learnPublicOnly(input.key);
          return send("public");
        },
      );

      logger.info(
        {
          driver: "vercel-blob",
          key: input.key,
          access: effectiveAccess,
          requestedAccess: access,
          contentType: input.contentType,
          bytes,
          durationMs: Date.now() - start,
        },
        "storage: object written",
      );
      // For private blobs, result.url is the authenticated access URL (not a
      // public CDN URL). We return result.pathname as the canonical key in all
      // cases; callers must use the adapter get() to retrieve private bytes.
      // `effectiveAccess` reflects the visibility the blob was actually written
      // with (see the public-only fallback above).
      return {
        url: result.url,
        key: result.pathname,
        bytes,
        access: effectiveAccess,
      };
    },

    async delete(urlOrKey: string): Promise<void> {
      const start = Date.now();
      // `del` accepts either the URL or the pathname.
      await blobDel(urlOrKey, { token });
      logger.info(
        {
          driver: "vercel-blob",
          key: urlOrKey,
          durationMs: Date.now() - start,
        },
        "storage: object deleted",
      );
    },
  };
}
