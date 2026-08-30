/**
 * Vendor-neutral storage adapter contract.
 *
 * Every file/blob in Oxagen is written through this interface so the concrete
 * backend (Vercel Blob today; S3 / Cloudflare R2 tomorrow) is a config-only
 * swap — never an import-site change. App / API / MCP code depends on
 * `StorageAdapter`, never on `@vercel/blob` directly.
 *
 * A stored object always yields a public, durable URL plus the canonical key
 * used to address it for later deletion. Binary payloads are accepted as the
 * web-standard shapes a route handler already has in hand (a `File`/`Blob` from
 * `formData()`, or a raw byte buffer).
 */
export type StorageBody = Blob | ArrayBuffer | Uint8Array;

export interface PutObjectInput {
  /**
   * Logical object key, e.g. `avatars/<userId>/<uuid>.webp`. The driver may
   * add an opaque suffix for uniqueness; the returned `key` is authoritative.
   */
  key: string;
  body: StorageBody;
  /** MIME type, e.g. `image/webp`. Stored as the object's content type. */
  contentType?: string;
  /**
   * Visibility of the stored object.
   *
   * - `"public"` (default) — object is accessible via its CDN URL without
   *   authentication. Use for avatars and any intentionally world-readable
   *   content.
   * - `"private"` — object requires the store's read-write token to access.
   *   The public CDN URL is never exposed; bytes are fetched server-side via
   *   the authenticated adapter `get()` method. Use for generated assets,
   *   workspace files, and any user-specific content.
   */
  access?: "public" | "private";
}

export interface PutObjectResult {
  /**
   * For `access: "public"` — the public, durable CDN URL the object is served
   * from. For `access: "private"` — the canonical pathname/key returned by the
   * SDK (same as `key`). Never expose a private blob's URL to end-users; always
   * route reads through the authenticated `get()` adapter method.
   */
  url: string;
  /** Canonical key to address the object later (e.g. for deletion). */
  key: string;
  /** Byte length written, for instrumentation/quota accounting. */
  bytes: number;
  /**
   * Whether the object was stored with public CDN access or requires
   * authenticated retrieval. Callers should persist this alongside `key`/`url`
   * so the serve path knows which read strategy to use.
   */
  access: "public" | "private";
}

/**
 * Result shape returned by {@link StorageAdapter.get}.
 *
 * `body` is a raw web-platform `ReadableStream` so callers can pipe it
 * directly into a `Response` without buffering the full object in memory.
 * Both `contentType` and `sizeBytes` mirror what the storage backend
 * reports in HTTP headers; either may be `null` when the backend omits
 * the header.
 */
export interface GetObjectResult {
  body: ReadableStream<Uint8Array>;
  contentType: string | null;
  sizeBytes: number | null;
}

export interface StorageAdapter {
  /** Driver identifier, for logs/metrics (e.g. "vercel-blob"). */
  readonly driver: string;
  /** Write an object and return its public URL + canonical key. */
  put(input: PutObjectInput): Promise<PutObjectResult>;
  /** Delete an object by the URL or key returned from {@link put}. Idempotent. */
  delete(urlOrKey: string): Promise<void>;
  /**
   * Stream an object by its canonical key. Throws a {@link StorageNotFoundError}
   * when the key does not exist. Does NOT buffer the body — pipe `result.body`
   * into a `Response` to stream bytes to the caller.
   */
  get(key: string): Promise<GetObjectResult>;
}
