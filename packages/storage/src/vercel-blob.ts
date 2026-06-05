import { put as blobPut, del as blobDel } from "@vercel/blob";
import { logger } from "./logger";
import type { PutObjectInput, PutObjectResult, StorageAdapter, StorageBody } from "./types";

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
  return {
    driver: "vercel-blob",

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
