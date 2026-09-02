/**
 * Shared asset rules — single source of truth for limits, allowed types, and
 * server-derived key generation. Imported by both the browser multipart upload
 * route (apps/app/src/app/api/v1/upload/avatar/route.ts) and the asset.upload
 * capability handler (@oxagen/handlers). Keeping them in one place eliminates
 * drift.
 */
import { randomUUID } from "node:crypto";

// ── Asset kind ────────────────────────────────────────────────────────────────

export type AssetKind = "avatar" | "image" | "document" | "video";

// ── Size limits (bytes) ───────────────────────────────────────────────────────

/**
 * Maximum byte size for each asset kind.
 * - avatar / image: 5 MiB — generous for browser-cropped images.
 * - document: 25 MiB — covers typical PDFs and office files.
 * - video: 100 MiB — short chat/agent attachment clips (not long-form media).
 */
export const ASSET_LIMITS: Record<AssetKind, number> = {
  avatar: 5 * 1024 * 1024,
  image: 5 * 1024 * 1024,
  document: 25 * 1024 * 1024,
  video: 100 * 1024 * 1024,
};

// ── Allowed MIME types ────────────────────────────────────────────────────────

/**
 * Allowed content-type → extension mapping per asset kind.
 *
 * avatar: raster formats only (webp / png / jpeg).
 * image: those plus gif (agent screenshots/recordings are commonly gif).
 * document: image formats plus PDF.
 * video: mp4 / webm / quicktime — short chat attachment clips.
 */
export const ASSET_ALLOWED_TYPES: Record<AssetKind, Record<string, string>> = {
  avatar: {
    "image/webp": "webp",
    "image/png": "png",
    "image/jpeg": "jpg",
  },
  image: {
    "image/webp": "webp",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
  },
  document: {
    "image/webp": "webp",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "application/pdf": "pdf",
  },
  video: {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  },
};

// ── Validation helpers ────────────────────────────────────────────────────────

/**
 * Assert that `mime` is an allowed content type for `kind`.
 *
 * Returns the file extension (e.g. `"webp"`) when the type is allowed.
 * Throws an `Error` with a user-facing message when it is not.
 *
 * Never throws for a valid (kind, mime) pair — callers can rely on the
 * returned extension being a non-empty string.
 *
 * `mime` is attacker-controlled (a multipart part's Content-Type header), so
 * the lookup goes through `Object.hasOwn` rather than a bare index. A bare
 * index resolves inherited `Object.prototype` keys — `"constructor"`,
 * `"toString"`, `"__proto__"` — to truthy values, which would sail past the
 * allowlist and let any bytes be stored under an arbitrary content type.
 */
export function assertAllowedAssetType(kind: AssetKind, mime: string): string {
  const allowed = ASSET_ALLOWED_TYPES[kind];
  const ext = Object.hasOwn(allowed, mime) ? allowed[mime] : undefined;
  if (!ext) {
    const permitted = Object.keys(allowed).join(", ");
    throw new Error(
      `Unsupported ${kind} type "${mime}". Permitted types: ${permitted}`,
    );
  }
  return ext;
}

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Derive a server-controlled storage key for a new asset.
 *
 * The key is `<kind>/<ownerId>/<uuid>.<ext>` where `ownerId` is always a
 * server-side value (org id, user id) — never user input. The UUID is
 * generated with `node:crypto` so the client can never predict or control
 * the storage path (prevents traversal and overwrite attacks).
 *
 * @param kind     - Asset category ("avatar" | "image" | "document").
 * @param ownerId  - Server-resolved owner identifier (org id or user id).
 * @param ext      - File extension without a leading dot, e.g. "webp".
 */
export function deriveAssetKey(
  kind: AssetKind,
  ownerId: string,
  ext: string,
): string {
  return `${kind}/${ownerId}/${randomUUID()}.${ext}`;
}
