import { requireEnv } from "@oxagen/config/env";
import { createVercelBlobAdapter } from "./vercel-blob";
import type { StorageAdapter } from "./types";

/**
 * Resolve the configured storage adapter (one instance per process).
 *
 * Driver selection is config-only — today it is always Vercel Blob, keyed by
 * `BLOB_READ_WRITE_TOKEN`. To eject to S3/R2, add the driver and branch here on
 * an env flag (e.g. `STORAGE_DRIVER`); no call site changes.
 *
 * The token is `.optional()` in the base env schema (not every service uploads),
 * so we guard explicitly and fail closed with a clear error here rather than
 * letting the Vercel SDK throw deep inside an upload.
 */
let _adapter: StorageAdapter | null = null;

export function storage(): StorageAdapter {
  if (_adapter) return _adapter;
  const { BLOB_READ_WRITE_TOKEN } = requireEnv(["BLOB_READ_WRITE_TOKEN"] as const);
  if (!BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN is not set — file uploads are unavailable. Add it to the environment to enable @oxagen/storage.",
    );
  }
  _adapter = createVercelBlobAdapter(BLOB_READ_WRITE_TOKEN);
  return _adapter;
}
