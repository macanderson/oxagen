// generated-asset.serve.ts — access-controlled streaming of AI-generated assets.
//
// Mirrors file.serve.ts (raw data access, not a kernel capability) but enforces
// the per-asset `access_policy` rather than plain org membership:
//
//   policy   | who may read
//   ---------|-------------------------------------------------------------
//   public   | anyone (no identity required)
//   org      | any member of the asset's org (app: membership; api: org match)
//   user     | only the generating user (app: userId match; api: denied — an
//            |   api key has no user identity to match the creator)
//
// Every authz failure (and a not-ready / missing-blob asset) returns notFound,
// never forbidden, so a non-member can't confirm an asset's existence via a
// 403/404 distinction (IDOR defence, same as serveFile).

import { eq, and } from "drizzle-orm";
import { db, schema } from "@oxagen/database";
import { storage, StorageNotFoundError } from "@oxagen/storage";
import { insertEvents } from "@oxagen/telemetry";
import { randomUUID } from "node:crypto";
import { logger } from "./logger";

export class GeneratedAssetNotFoundError extends Error {
  readonly notFound = true as const;
  constructor(assetId: string) {
    super(`Generated asset not found: ${assetId}`);
    this.name = "GeneratedAssetNotFoundError";
  }
}

export class GeneratedAssetForbiddenError extends Error {
  readonly forbidden = true as const;
  constructor() {
    super("Insufficient credentials to serve generated asset");
    this.name = "GeneratedAssetForbiddenError";
  }
}

export interface AssetServePrincipal {
  /** Present on the api surface (pre-bound by the API-key middleware). */
  orgId?: string;
  /** Present on the api surface when the key is workspace-scoped. */
  workspaceId?: string;
  /** Present on the app surface (session userId). */
  userId?: string;
  surface: "api" | "app";
  requestId?: string;
}

export interface AssetServeResult {
  body: ReadableStream<Uint8Array>;
  mimeType: string;
  sizeBytes: bigint | null;
  contentDisposition: "inline" | "attachment";
}

/**
 * Generated assets are image/video only, both render-safe inline. SVG is never
 * produced by this path (svg.generate renders inline markup, not a stored blob),
 * so an image/* or video/* type is served inline; anything else is forced to
 * attachment as a defensive default.
 */
function safeContentDisposition(mimeType: string): "inline" | "attachment" {
  const type = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("image/") && type !== "image/svg+xml") return "inline";
  if (type.startsWith("video/") || type.startsWith("audio/")) return "inline";
  return "attachment";
}

/** Whether `principal` may read an asset under the given access policy. */
async function authorize(
  asset: { orgId: string; workspaceId: string; userId: string; accessPolicy: string },
  principal: AssetServePrincipal,
): Promise<boolean> {
  if (asset.accessPolicy === "public") return true;

  if (asset.accessPolicy === "user") {
    // Creator-only: requires a session user identity that matches.
    return principal.userId !== undefined && principal.userId === asset.userId;
  }

  // org policy.
  if (principal.orgId) {
    if (asset.orgId !== principal.orgId) return false;
    if (principal.workspaceId && asset.workspaceId !== principal.workspaceId) return false;
    return true;
  }
  if (principal.userId) {
    // tenancy: unscoped seam (not a kernel capability — no ALS tenant scope;
    // authz enforced by principal fields, not RLS) — OXA-1515
    const membership = await db()
      .select({ id: schema.orgUsers.id })
      .from(schema.orgUsers)
      .where(and(eq(schema.orgUsers.orgId, asset.orgId), eq(schema.orgUsers.userId, principal.userId)))
      .limit(1);
    return membership.length > 0;
  }
  return false;
}

/**
 * Authorise and stream a generated asset by its `publicId` ("gen_…").
 *
 * @throws {GeneratedAssetForbiddenError} When no usable identity is present for
 *   a non-public asset.
 * @throws {GeneratedAssetNotFoundError} When the asset is absent, not yet ready,
 *   the caller is not authorised, or the storage object is missing.
 */
export async function serveGeneratedAsset(
  assetId: string,
  principal: AssetServePrincipal,
): Promise<AssetServeResult> {
  // tenancy: unscoped seam (not a kernel capability — called directly from the
  // route layer without a kernel invocation; no ALS tenant scope is present;
  // authz is enforced by the access_policy + principal's orgId/userId) — OXA-1515
  const rows = await db()
    .select()
    .from(schema.generatedAssets)
    .where(eq(schema.generatedAssets.publicId, assetId))
    .limit(1);

  const asset = rows[0];
  if (!asset || asset.deletedAt !== null || asset.status !== "ready") {
    logger.warn({ assetId, surface: principal.surface }, "asset.serve: not found or not ready");
    throw new GeneratedAssetNotFoundError(assetId);
  }

  // A non-public asset with no identity at all is a forbidden (missing auth)
  // case; everything else that fails authz is a notFound (existence hidden).
  if (asset.accessPolicy !== "public" && !principal.orgId && !principal.userId) {
    throw new GeneratedAssetForbiddenError();
  }

  const allowed = await authorize(asset, principal);
  if (!allowed) {
    logger.warn(
      { assetId, accessPolicy: asset.accessPolicy, surface: principal.surface },
      "asset.serve: access denied",
    );
    throw new GeneratedAssetNotFoundError(assetId);
  }

  let obj: Awaited<ReturnType<ReturnType<typeof storage>["get"]>>;
  try {
    obj = await storage().get(asset.storageKey);
  } catch (err) {
    if (err instanceof StorageNotFoundError) {
      logger.error(
        { assetId, storageKey: asset.storageKey, surface: principal.surface },
        "asset.serve: storage object missing for asset row",
      );
      throw new GeneratedAssetNotFoundError(assetId);
    }
    throw err;
  }

  // Fire-and-forget telemetry; never blocks the response stream.
  void (async () => {
    try {
      await insertEvents([
        {
          event_id: randomUUID(),
          org_id: asset.orgId,
          workspace_id: asset.workspaceId,
          event_type: "generated_asset.served",
          source_system: principal.surface,
          stream_offset: null,
          payload: JSON.stringify({
            assetId,
            kind: asset.kind,
            accessPolicy: asset.accessPolicy,
            ...(principal.requestId ? { requestId: principal.requestId } : {}),
          }),
          emitted_at: new Date().toISOString(),
        },
      ]);
    } catch (telemetryErr) {
      logger.warn(
        { assetId, surface: principal.surface, err: telemetryErr },
        "asset.serve: telemetry insert failed (non-fatal)",
      );
    }
  })();

  return {
    body: obj.body,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    contentDisposition: safeContentDisposition(asset.mimeType),
  };
}
