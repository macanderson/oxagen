import { requireEnv } from "@oxagen/config/env";
import { createVercelBlobAdapter } from "./vercel-blob";
import { createFsAdapter } from "./fs-driver";
import type { StorageAdapter } from "./types";

/** Drivers supported by the STORAGE_DRIVER env var. */
const SUPPORTED_DRIVERS = ["vercel-blob", "fs"] as const;

/**
 * Resolve the configured storage adapter based on the STORAGE_DRIVER env var.
 *
 * Each case is responsible for reading any driver-specific env vars it needs
 * (e.g. BLOB_READ_WRITE_TOKEN for vercel-blob). This keeps driver credentials
 * isolated -- adding a new driver never requires touching unrelated config.
 *
 * To add a new driver:
 *  1. Implement the StorageAdapter interface.
 *  2. Add the driver name to STORAGE_DRIVER enum in packages/config/src/env.ts.
 *  3. Add a case here that reads the driver's env vars and returns the adapter.
 */
function resolveAdapter(): StorageAdapter {
  const { STORAGE_DRIVER } = requireEnv(["STORAGE_DRIVER"] as const);
  const driver = STORAGE_DRIVER ?? "vercel-blob";

  switch (driver) {
    case "vercel-blob": {
      const { BLOB_READ_WRITE_TOKEN } = requireEnv([
        "BLOB_READ_WRITE_TOKEN",
      ] as const);
      if (!BLOB_READ_WRITE_TOKEN) {
        throw new Error(
          "BLOB_READ_WRITE_TOKEN is not set — file uploads are unavailable. Add it to the environment to enable @oxagen/storage.",
        );
      }
      return createVercelBlobAdapter(BLOB_READ_WRITE_TOKEN);
    }
    case "fs": {
      // Filesystem driver — no credential required. Bytes land under
      // STORAGE_FS_ROOT (an absolute OS-tmp path by default). Used by the CI
      // e2e container and local dev where no Vercel Blob token exists.
      const { STORAGE_FS_ROOT } = requireEnv(["STORAGE_FS_ROOT"] as const);
      return createFsAdapter(STORAGE_FS_ROOT);
    }
    default:
      throw new Error(
        `Unknown STORAGE_DRIVER: "${driver}". Supported drivers: ${SUPPORTED_DRIVERS.join(", ")}.`,
      );
  }
}

/**
 * Resolve the configured storage adapter (one instance per process).
 *
 * Driver selection is controlled by STORAGE_DRIVER (defaults to "vercel-blob").
 * The singleton is lazily initialized on first call and memoized for the
 * lifetime of the process.
 */
let _adapter: StorageAdapter | null = null;

export function storage(): StorageAdapter {
  if (_adapter) return _adapter;
  _adapter = resolveAdapter();
  return _adapter;
}
