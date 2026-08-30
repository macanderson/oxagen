import { createReadStream } from "node:fs";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
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
 * Default storage root when STORAGE_FS_ROOT is unset. An OS-tmp-scoped absolute
 * path is chosen deliberately over a cwd-relative one: the app (`next start`,
 * cwd = apps/app) and the API (`tsx`, cwd = repo root) run as separate processes
 * with different working directories, and both must resolve the SAME directory
 * or an object written by one is invisible to the other. An absolute path is
 * also always writable inside the CI e2e container.
 */
const DEFAULT_ROOT = join(tmpdir(), "oxagen-storage");

/**
 * Resolve the configured root to an absolute path. A relative STORAGE_FS_ROOT
 * is anchored at `process.cwd()` (documented, but discouraged — see
 * DEFAULT_ROOT for why absolute is safer across the app/API process split).
 */
function resolveRoot(root: string | undefined): string {
  const raw = root && root.trim().length > 0 ? root.trim() : DEFAULT_ROOT;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

/**
 * Map a logical object key to a concrete, sandboxed filesystem path under
 * `root`, rejecting any key that would escape the root via traversal
 * (`..`), an absolute path, or a null byte.
 *
 * The returned path is always strictly inside `root` — `root` itself is never
 * returned, since a key must name a file. This is the sole guard against a
 * caller-supplied key writing or reading outside the storage sandbox.
 *
 * @throws {Error} When the key is empty or resolves outside `root`.
 */
function keyToPath(root: string, key: string): string {
  if (!key || key.trim().length === 0) {
    throw new Error("fs storage: object key must be a non-empty string.");
  }
  if (key.includes("\0")) {
    throw new Error("fs storage: object key must not contain a null byte.");
  }
  // Reject explicitly-absolute keys before normalisation — a leading "/" or a
  // Windows drive letter would otherwise re-root the join and escape the sandbox.
  if (isAbsolute(key)) {
    throw new Error(`fs storage: object key must be relative, got "${key}".`);
  }

  const target = resolve(root, key);
  // The resolved path must live strictly under root. Comparing against
  // `root + sep` rejects both traversal escapes and the root dir itself.
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (!target.startsWith(rootWithSep)) {
    throw new Error(
      `fs storage: object key "${key}" resolves outside the storage root.`,
    );
  }
  return target;
}

/** Normalise any accepted body shape to a Buffer for a single atomic write. */
async function toBuffer(body: StorageBody): Promise<Buffer> {
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(new Uint8Array(body)); // ArrayBuffer
}

/**
 * Filesystem storage driver for the storage adapter.
 *
 * Writes each object as a real file under `root`, preserving the logical key as
 * a sanitised relative path. It exists so file uploads work in environments
 * without a Vercel Blob token — the CI e2e container and any local dev machine —
 * keeping the four-store rule intact (bytes on the local filesystem; the
 * reference row still lives in Postgres via persistGeneratedAsset).
 *
 * Access semantics
 * ----------------
 * The driver serves bytes back only through the authenticated adapter `get()`
 * path (the app's /api/v1/assets/[publicId] proxy reads them there); it has no
 * public CDN. For BOTH access levels the returned `url` is the canonical key
 * (identical to `key`), matching the vendor-neutral contract's private-object
 * rule. Callers that render a public URL directly (e.g. avatar <img src>) are
 * unsupported by this driver — it is a test/local backend, not a CDN.
 */
export function createFsAdapter(rootDir: string | undefined): StorageAdapter {
  const root = resolveRoot(rootDir);

  return {
    driver: "fs",

    async put(input: PutObjectInput): Promise<PutObjectResult> {
      const start = Date.now();
      const access = input.access ?? "public";
      const target = keyToPath(root, input.key);
      const buf = await toBuffer(input.body);

      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, buf);

      logger.info(
        {
          driver: "fs",
          key: input.key,
          access,
          contentType: input.contentType,
          bytes: buf.length,
          durationMs: Date.now() - start,
        },
        "storage: object written",
      );
      // `url === key` (no CDN); callers read private bytes back via get(key).
      return { url: input.key, key: input.key, bytes: buf.length, access };
    },

    async get(key: string): Promise<GetObjectResult> {
      const start = Date.now();
      const target = keyToPath(root, key);

      let sizeBytes: number;
      try {
        sizeBytes = (await stat(target)).size;
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === "ENOENT") {
          logger.warn(
            { driver: "fs", key, durationMs: Date.now() - start },
            "storage: get — object not found",
          );
          throw new StorageNotFoundError(key);
        }
        throw err;
      }

      // Stream the bytes rather than buffering the whole object in memory, so
      // callers can pipe straight into a Response (matches the adapter contract).
      const body = Readable.toWeb(
        createReadStream(target),
      ) as ReadableStream<Uint8Array>;

      logger.info(
        { driver: "fs", key, sizeBytes, durationMs: Date.now() - start },
        "storage: object read",
      );
      // The fs backend does not persist a content-type; the serving layer reads
      // MIME from the Postgres asset row, so a null here is contract-legal.
      return {
        body,
        contentType: null,
        sizeBytes: sizeBytes > 0 ? sizeBytes : null,
      };
    },

    async delete(urlOrKey: string): Promise<void> {
      const start = Date.now();
      // This driver's put() returns `url === key`, so anything it wrote is
      // addressed by its logical key. A caller that hands back a URL written by
      // a DIFFERENT driver (a stored `https://…` Vercel Blob URL, after
      // STORAGE_DRIVER flipped) resolves to a path that does not exist and the
      // ENOENT branch below silently no-ops — deletion across a driver switch
      // is not supported.
      const target = keyToPath(root, urlOrKey);
      try {
        await unlink(target);
      } catch (err: unknown) {
        // Idempotent: deleting a missing object is a no-op, never an error.
        if ((err as { code?: string })?.code === "ENOENT") return;
        throw err;
      }
      logger.info(
        { driver: "fs", key: urlOrKey, durationMs: Date.now() - start },
        "storage: object deleted",
      );
    },
  };
}
