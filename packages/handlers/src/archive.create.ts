// archive.create.ts — ZIP archive generation using fflate (pure JS, serverless-safe).
// Entries can be sourced from existing generated assets (fetched from blob storage
// by publicId), inline base64 blobs, or UTF-8 text. The archive is uploaded via
// persistGeneratedAsset() and served through the access-controlled asset route.

import { inArray } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { storage } from "@oxagen/storage";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { archiveCreate } from "@oxagen/oxagen/contracts/archive.create";
import { logger } from "./logger";
import { persistGeneratedAsset } from "./generated-asset.persist";

// ── Entry resolution ──────────────────────────────────────────────────────────

/**
 * Batch-fetch the storage metadata for every referenced asset in ONE query.
 * System bypass — no kernel scope at this layer; per-entry org authz is enforced
 * by resolveEntry against each row's orgId. The row type is inferred from this
 * select so it always matches the real drizzle column types.
 */
async function fetchAssetRows(assetIds: string[]) {
  return withSystemDb((tx) =>
    tx
      .select({
        publicId: schema.generatedAssets.publicId,
        storageKey: schema.generatedAssets.storageKey,
        orgId: schema.generatedAssets.orgId,
        status: schema.generatedAssets.status,
        deletedAt: schema.generatedAssets.deletedAt,
      })
      .from(schema.generatedAssets)
      .where(inArray(schema.generatedAssets.publicId, assetIds)),
  );
}

type AssetRow = Awaited<ReturnType<typeof fetchAssetRows>>[number];

/** Load all referenced assets up front, keyed by publicId. */
async function loadAssets(assetIds: string[]): Promise<Map<string, AssetRow>> {
  if (assetIds.length === 0) return new Map();
  const rows = await fetchAssetRows(assetIds);
  return new Map(rows.map((r) => [r.publicId, r]));
}

/**
 * Resolve a single archive entry to its raw bytes.
 *
 * Priority: assetId > contentBase64 > text. An entry must provide at least one.
 */
async function resolveEntry(
  entry: { name: string; assetId?: string; contentBase64?: string; text?: string },
  orgId: string,
  assetsById: Map<string, AssetRow>,
): Promise<Uint8Array> {
  if (entry.assetId) {
    // The asset row was batch-loaded up front (one query for all entries).
    // Authz: only assets belonging to the caller's org are accessible (orgId
    // guard enforced below), identical to the prior per-entry lookup.
    const asset = assetsById.get(entry.assetId);
    if (
      !asset ||
      asset.deletedAt !== null ||
      asset.status !== "ready" ||
      asset.orgId !== orgId
    ) {
      throw new Error(
        `archive.create: asset not found or not accessible: ${entry.assetId}`,
      );
    }

    const obj = await storage().get(asset.storageKey);
    // Collect the ReadableStream into a Uint8Array.
    const reader = obj.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        totalLength += value.length;
      }
    }
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }

  if (entry.contentBase64) {
    const binaryStr = atob(entry.contentBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return bytes;
  }

  if (entry.text !== undefined) {
    return new TextEncoder().encode(entry.text);
  }

  throw new Error(
    `archive.create: entry "${entry.name}" must supply assetId, contentBase64, or text`,
  );
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const archiveCreateHandler: CapabilityHandler<typeof archiveCreate> = async (
  input,
  ctx,
) => {
  if (!ctx.userId) {
    throw new Error("archive.create: userId is required — no user identity in context");
  }

  const { archiveName, entries } = input;

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      archiveName,
      entryCount: entries.length,
    },
    "archive.create: starting",
  );

  // Batch-load every referenced asset in ONE query (was one SELECT per entry).
  // Blob fetches still run per-entry in parallel below.
  const assetIds = [
    ...new Set(entries.map((e) => e.assetId).filter((id): id is string => Boolean(id))),
  ];
  const assetsById = await loadAssets(assetIds);

  // Resolve all entries in parallel — independent blob fetches.
  const resolved = await Promise.all(
    entries.map(async (entry) => {
      const bytes = await resolveEntry(entry, ctx.orgId, assetsById);
      return { name: entry.name, bytes };
    }),
  );

  // Build the ZIP with fflate. We use the synchronous zipSync for simplicity
  // since the blobs are already in memory. For archives with very large
  // individual entries, consider the async zip() variant.
  const { zipSync } = await import("fflate");

  const zipInput: Record<string, Uint8Array> = {};
  for (const { name, bytes } of resolved) {
    zipInput[name] = bytes;
  }

  const zipBytes = zipSync(zipInput, { level: 6 });

  const mimeType = "application/zip";

  const userId = ctx.userId; // narrowed to string by the guard above
  const asset = await persistGeneratedAsset({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId,
    kind: "archive",
    mimeType,
    bytes: zipBytes,
    prompt: `Create archive: ${archiveName}`,
    model: "local",
    messageId: ctx.messageId ?? undefined,
    accessPolicy: "org",
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      archiveName,
      publicId: asset.publicId,
      sizeBytes: asset.sizeBytes,
    },
    "archive.create: complete",
  );

  const filename = `${archiveName}.zip`;

  return {
    assetId: asset.id,
    publicId: asset.publicId,
    kind: "archive",
    mimeType,
    sizeBytes: asset.sizeBytes,
    url: asset.url,
    serveUrl: asset.serveUrl,
    render: {
      componentId: "file-attachment",
      props: {
        url: asset.serveUrl,
        name: filename,
        kind: "archive",
        mimeType,
        sizeBytes: asset.sizeBytes,
      },
    },
  };
};
