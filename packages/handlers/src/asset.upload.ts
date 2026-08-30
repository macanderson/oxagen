import type { CapabilityHandler } from "@oxagen/oxagen";
import { assetUpload } from "@oxagen/oxagen/contracts/asset.upload";
import {
  ASSET_LIMITS,
  assertAllowedAssetType,
  deriveAssetKey,
} from "@oxagen/storage";
import { storage } from "@oxagen/storage";
import { logger } from "./logger";
import {
  persistGeneratedAsset,
  type AssetKind as GeneratedAssetKind,
} from "./generated-asset.persist";

// ── SSRF protection ───────────────────────────────────────────────────────────

/**
 * Assert that `raw` is a publicly routable http:// or https:// URL.
 *
 * Rejects:
 *  - Non-http/https schemes (ftp, file, data, …)
 *  - IP literals in private/loopback/link-local/unique-local ranges:
 *      127.0.0.0/8      — loopback (IPv4)
 *      10.0.0.0/8       — private class A
 *      172.16.0.0/12    — private class B
 *      192.168.0.0/16   — private class C
 *      169.254.0.0/16   — link-local (incl. 169.254.169.254 IMDS)
 *      0.0.0.0          — unspecified
 *      ::1              — IPv6 loopback
 *      fe80::/10        — IPv6 link-local
 *      fc00::/7         — IPv6 unique-local (fc00:: and fd00::)
 *  - Bare hostnames "localhost" and "metadata.google.internal"
 *
 * Throws an `Error` if any check fails.
 */
export function assertPublicHttpUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Refusing to fetch non-public URL: invalid URL "${raw}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Refusing to fetch non-public URL: scheme "${parsed.protocol}" is not allowed`,
    );
  }

  const host = parsed.hostname.toLowerCase();

  // Bare hostname blocklist
  const blockedHostnames = new Set(["localhost", "metadata.google.internal"]);
  if (blockedHostnames.has(host)) {
    throw new Error(
      `Refusing to fetch non-public URL: hostname "${host}" is not allowed`,
    );
  }

  // IPv6 literal (wrapped in brackets in the URL hostname field)
  if (host.startsWith("[")) {
    const ipv6 = host.slice(1, -1); // strip brackets
    if (isPrivateIPv6(ipv6)) {
      throw new Error(
        `Refusing to fetch non-public URL: IPv6 address "${ipv6}" is in a non-routable range`,
      );
    }
    return; // valid public IPv6
  }

  // IPv4 — only block if it parses as an IP literal (4 octets)
  if (isIPv4Literal(host)) {
    if (isPrivateIPv4(host)) {
      throw new Error(
        `Refusing to fetch non-public URL: IPv4 address "${host}" is in a non-routable range`,
      );
    }
  }
}

function isIPv4Literal(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function parseIPv4Octet(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? -1 : n;
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".").map(parseIPv4Octet);
  if (parts.length !== 4 || parts.some((p) => p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];

  return (
    a === 0 || // 0.0.0.0/8 — unspecified
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) // 169.254.0.0/16 (incl. 169.254.169.254 IMDS)
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // ::1 — loopback
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  // fe80::/10 — link-local
  if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true;
  // fc00::/7 — unique-local (covers fc00:: and fd00::)
  if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true;
  return false;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const assetUploadHandler: CapabilityHandler<typeof assetUpload> = async (
  input,
  ctx,
) => {
  // Authorization guard: require a resolved principal and an org scope.
  if (!ctx.userId && !ctx.apiKeyId) {
    logger.warn(
      { orgId: ctx.orgId },
      "asset.upload: rejected — no authenticated principal",
    );
    throw new Error("Unauthorized: no authenticated principal");
  }
  if (!ctx.orgId) {
    logger.warn({}, "asset.upload: rejected — missing orgId");
    throw new Error("Forbidden: orgId is required to upload assets");
  }

  const { sourceUrl, kind, source, conversationId } = input;

  // "user_upload" additionally records a generated_assets row so the asset
  // shows up in conversation.files.list and is servable via the
  // access-controlled /api/v1/assets/:publicId route. Validate the
  // preconditions up front so we fail before ever fetching the source URL.
  if (source === "user_upload") {
    if (kind === "avatar") {
      throw new Error(
        'asset.upload: source "user_upload" is not supported for kind "avatar"',
      );
    }
    if (!ctx.userId) {
      throw new Error(
        'asset.upload: source "user_upload" requires an authenticated user (not an API-key-only principal)',
      );
    }
    if (!ctx.workspaceId) {
      throw new Error(
        'asset.upload: source "user_upload" requires a workspace scope',
      );
    }
  } else if (conversationId) {
    throw new Error(
      'asset.upload: conversationId requires source "user_upload"',
    );
  }

  // SSRF protection: only allow publicly routable http(s) URLs.
  assertPublicHttpUrl(sourceUrl);

  // Fetch the asset with a 10-second timeout.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await fetch(sourceUrl, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(
      `asset.upload: source URL responded with HTTP ${response.status}`,
    );
  }

  // Determine content type from the response header (strip ; charset=… params).
  const rawContentType = response.headers.get("content-type") ?? "";
  const contentType = rawContentType.split(";")[0]?.trim() ?? "";

  // Validate content type against the asset kind.
  const ext = assertAllowedAssetType(kind, contentType);

  // Read the body and enforce the size limit.
  const limit = ASSET_LIMITS[kind];
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > limit) {
    const limitMb = (limit / (1024 * 1024)).toFixed(0);
    throw new Error(
      `Asset exceeds the ${limit} byte limit (${limitMb} MiB) for kind "${kind}"`,
    );
  }

  // "user_upload": store as a PRIVATE blob and record a generated_assets row
  // via the single shared persistence chokepoint (no second insert path —
  // reused by image.generate/video.generate/the chat composer too).
  if (source === "user_upload") {
    const persisted = await persistGeneratedAsset({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId!,
      userId: ctx.userId!,
      kind: kind as GeneratedAssetKind,
      accessPolicy: "org",
      bytes: new Uint8Array(buffer),
      mimeType: contentType,
      prompt: "",
      model: "",
      conversationId: conversationId ?? null,
      source: "user_upload",
    });

    logger.info(
      {
        orgId: ctx.orgId,
        kind,
        source,
        publicId: persisted.publicId,
        bytes: persisted.sizeBytes,
        surface: ctx.surface,
      },
      "asset.upload: stored as a user-upload attachment",
    );

    return {
      url: persisted.serveUrl,
      key: persisted.key,
      contentType,
      bytes: persisted.sizeBytes,
      publicId: persisted.publicId,
    };
  }

  // Pure blob-ingest path (avatar/image/document, no source given):
  // public blob, no DB row.
  // Derive a server-controlled storage key (user-input never touches the path).
  const key = deriveAssetKey(kind, ctx.orgId, ext);

  // Write to object storage.
  const { url, bytes } = await storage().put({
    key,
    body: new Uint8Array(buffer),
    contentType,
    access: "public",
  });

  logger.info(
    { orgId: ctx.orgId, kind, bytes, surface: ctx.surface },
    "asset.upload: stored",
  );

  return { url, key, contentType, bytes, publicId: null };
};
