/**
 * Typed error thrown when a storage key does not exist (HTTP 404 from the
 * backend). Route handlers should map this to a 404 response without leaking
 * the internal storage URL.
 *
 * Shared across all storage drivers -- every adapter implementation must throw
 * this when the requested object is not found.
 */
export class StorageNotFoundError extends Error {
  readonly notFound = true as const;
  constructor(key: string) {
    super(`Storage object not found: ${key}`);
    this.name = "StorageNotFoundError";
  }
}
