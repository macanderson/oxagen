/**
 * @oxagen/storage — vendor-neutral file/blob storage.
 *
 * Public surface:
 *   storage()                  → the configured StorageAdapter (singleton)
 *   createVercelBlobAdapter()  → construct the Vercel Blob driver explicitly
 *   StorageAdapter, Put*       → the adapter contract types
 *
 * Never import `@vercel/blob` outside this package. See
 * [[storage-vercel-blob-adapter]].
 */
export { storage } from "./client";
export { createVercelBlobAdapter, publicBaseUrlFromToken, StorageNotFoundError } from "./vercel-blob";
export type {
  StorageAdapter,
  StorageBody,
  PutObjectInput,
  PutObjectResult,
  GetObjectResult,
} from "./types";
