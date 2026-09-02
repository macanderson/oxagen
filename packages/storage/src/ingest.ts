/**
 * Server-side image ingestion from an external URL into the vendor-neutral
 * storage adapter.
 *
 * Used when a user signs in with Google / GitHub: the provider hands us a CDN
 * URL for the user's avatar (e.g. `lh3.googleusercontent.com/...`,
 * `avatars.githubusercontent.com/...`). Rather than persisting that external
 * reference as a durable asset (the blob would then live on a third party's
 * CDN, violating the storage boundary — the binary must live in our store with
 * a reference row in Postgres), we copy the bytes into our blob store and return
 * OUR url.
 *
 * SECURITY (SSRF): the source URL is attacker-influenceable (it rides a form
 * submission), so fetching is restricted to an allowlist of known OAuth avatar
 * hosts over https only. `ingestImageFromUrl` re-checks the host internally so a
 * caller can never be tricked into fetching an internal address.
 */
import {
  ASSET_ALLOWED_TYPES,
  ASSET_LIMITS,
  deriveAssetKey,
  type AssetKind,
} from "./assets";
import { storage } from "./client";
import type { PutObjectInput, PutObjectResult } from "./types";

/**
 * Host suffixes we will fetch avatar bytes from. Both Google and GitHub serve
 * verified-profile avatars from these domains; nothing else is fetchable.
 *
 * - Google: `lh3.googleusercontent.com` … `lh6.googleusercontent.com`
 * - GitHub: `avatars.githubusercontent.com`
 */
const INGEST_HOST_SUFFIXES = [
  ".googleusercontent.com",
  ".githubusercontent.com",
] as const;

/**
 * True when `url` is an https URL on a trusted OAuth-avatar host and is
 * therefore safe to fetch server-side. Pure — safe to call from any runtime.
 */
export function isIngestibleImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return INGEST_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Injectable dependencies — defaults wire the real fetch + storage adapter. */
export interface IngestImageDeps {
  fetchImpl?: typeof fetch;
  putImpl?: (input: PutObjectInput) => Promise<PutObjectResult>;
}

export interface IngestImageFromUrlInput {
  /** External image URL (must be a trusted OAuth-avatar host, https). */
  url: string;
  /** Asset category — drives the size limit and allowed MIME set. */
  kind: AssetKind;
  /** Server-resolved owner id (user id / org id). Never client-controlled. */
  ownerId: string;
  /** Stored object visibility. Avatars are world-readable → "public". */
  access?: "public" | "private";
}

/**
 * Fetch an external image and store it via the storage adapter, returning the
 * stored object's url/key/bytes. Returns `null` (never throws) on any failure —
 * an untrusted host, non-image content type, oversize/empty body, network
 * error, or storage error — so callers can fall back gracefully.
 */
export async function ingestImageFromUrl(
  input: IngestImageFromUrlInput,
  deps: IngestImageDeps = {},
): Promise<PutObjectResult | null> {
  const { url, kind, ownerId, access = "public" } = input;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const putImpl = deps.putImpl ?? ((i: PutObjectInput) => storage().put(i));

  // Defense in depth: re-validate the host here so this function is safe even if
  // a caller forgets the `isIngestibleImageUrl` pre-check.
  if (!isIngestibleImageUrl(url)) return null;

  // SSRF defense: do NOT blindly follow redirects. An open redirect on a
  // trusted OAuth host (or a path that 302s) could otherwise send fetch to an
  // internal address (e.g. http://169.254.169.254/ metadata, RFC1918 hosts),
  // bypassing the host allowlist. We follow manually, re-validating every hop's
  // target through isIngestibleImageUrl, with a small hop cap.
  const MAX_REDIRECTS = 3;
  let currentUrl = url;
  let res: Response;
  try {
    let hops = 0;
    for (;;) {
      res = await fetchImpl(currentUrl, { redirect: "manual" });
      const status = res.status;
      const isRedirect =
        status === 301 ||
        status === 302 ||
        status === 303 ||
        status === 307 ||
        status === 308;
      if (!isRedirect) break;
      if (hops >= MAX_REDIRECTS) return null;
      const location = res.headers.get("location");
      if (!location) return null;
      // Resolve relative redirects against the current URL, then re-check the
      // host allowlist before following.
      let next: string;
      try {
        next = new URL(location, currentUrl).toString();
      } catch {
        return null;
      }
      if (!isIngestibleImageUrl(next)) return null;
      currentUrl = next;
      hops += 1;
    }
  } catch {
    return null;
  }
  if (!res.ok) return null;

  // Map the response content type to an allowed extension for this kind.
  const contentType = (res.headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (!contentType) return null;
  // `Object.hasOwn` guard, not a bare index: the remote host controls this
  // header, and inherited Object.prototype keys ("constructor", "toString",
  // "__proto__") resolve to truthy values that would bypass the allowlist.
  const allowed = ASSET_ALLOWED_TYPES[kind];
  const ext = Object.hasOwn(allowed, contentType)
    ? allowed[contentType]
    : undefined;
  if (!ext) return null;

  let body: ArrayBuffer;
  try {
    body = await res.arrayBuffer();
  } catch {
    return null;
  }
  if (body.byteLength === 0 || body.byteLength > ASSET_LIMITS[kind])
    return null;

  const key = deriveAssetKey(kind, ownerId, ext);
  try {
    return await putImpl({ key, body, contentType, access });
  } catch {
    return null;
  }
}
