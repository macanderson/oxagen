/**
 * @oxagen/storage — vendor-neutral file/blob storage.
 *
 * Public surface:
 *   storage()                  → the configured StorageAdapter (singleton)
 *   createVercelBlobAdapter()  → construct the Vercel Blob driver explicitly
 *   StorageAdapter, Put*       → the adapter contract types
 *   AssetKind                  → "avatar" | "image" | "document" | "video"
 *   ASSET_LIMITS               → max byte sizes per kind
 *   ASSET_ALLOWED_TYPES        → allowed MIME types per kind
 *   assertAllowedAssetType()   → validate MIME type or throw
 *   deriveAssetKey()           → server-controlled storage key
 *
 * Never import `@vercel/blob` outside this package.
 */
export { storage } from "./client";
export { createVercelBlobAdapter, publicBaseUrlFromToken } from "./vercel-blob";
export { createFsAdapter } from "./fs-driver";
export { StorageNotFoundError } from "./errors";
export type {
  StorageAdapter,
  StorageBody,
  PutObjectInput,
  PutObjectResult,
  GetObjectResult,
} from "./types";
export {
  ASSET_LIMITS,
  ASSET_ALLOWED_TYPES,
  assertAllowedAssetType,
  deriveAssetKey,
} from "./assets";
export type { AssetKind } from "./assets";
export { ingestImageFromUrl, isIngestibleImageUrl } from "./ingest";
export type {
  IngestImageDeps,
  IngestImageFromUrlInput,
} from "./ingest";
