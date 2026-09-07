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
import { schema, withSystemDb } from "@oxagen/database";
import { storage, StorageNotFoundError } from "@oxagen/storage";
import { insertEvents } from "@oxagen/telemetry";
import { randomUUID } from "node:crypto";
import { logger } from "./logger";
import {
  assetDisplayName,
  assetDispositionType,
  contentDispositionHeader,
} from "./lib/asset-filename";

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
  /**
   * The complete Content-Disposition header value, including the human-readable
   * `filename` (and RFC 5987 `filename*`). The disposition itself is `inline`
   * for browser-renderable types (images, video, audio, PDF, text/markdown) so
   * clicking a filename DISPLAYS the document; other binaries are `attachment`.
   * Either way the browser names the file from the slug, never the `gen_…` id.
   */
  contentDisposition: string;
}

/** Whether `principal` may read an asset under the given access policy. */
async function authorize(
  asset: {
    orgId: string;
    workspaceId: string;
    userId: string;
    accessPolicy: string;
  },
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
    if (principal.workspaceId && asset.workspaceId !== principal.workspaceId)
      return false;
    return true;
  }
  if (principal.userId) {
    // tenancy: system bypass via withSystemDb (not a kernel capability — no ALS
    // tenant scope; authz enforced in-code by access_policy + userId match,
    // not by RLS) (see docs/specs/tenancy-rls/spec.md)
    const membership = await withSystemDb((tx) =>
      tx
        .select({ id: schema.orgUsers.id })
        .from(schema.orgUsers)
        .where(
          and(
            eq(schema.orgUsers.orgId, asset.orgId),
            eq(schema.orgUsers.userId, principal.userId!),
          ),
        )
        .limit(1),
    );
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
  // tenancy: system bypass via withSystemDb (not a kernel capability — called
  // directly from the route layer without a kernel invocation; no ALS tenant
  // scope is present; authz is enforced in-code by access_policy + principal's
  // orgId/userId, not by RLS) (see docs/specs/tenancy-rls/spec.md)
  const rows = await withSystemDb((tx) =>
    tx
      .select()
      .from(schema.generatedAssets)
      .where(eq(schema.generatedAssets.publicId, assetId))
      .limit(1),
  );

  const asset = rows[0];
  if (!asset || asset.deletedAt !== null || asset.status !== "ready") {
    logger.warn(
      { assetId, surface: principal.surface },
      "asset.serve: not found or not ready",
    );
    throw new GeneratedAssetNotFoundError(assetId);
  }

  // A non-public asset with no identity at all is a forbidden (missing auth)
  // case; everything else that fails authz is a notFound (existence hidden).
  if (
    asset.accessPolicy !== "public" &&
    !principal.orgId &&
    !principal.userId
  ) {
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

  // Name the served file by its human-readable slug (identical to the name shown
  // in the Conversation Files panel) so downloads carry a recognisable filename
  // + extension instead of the opaque `gen_…` public id.
  const filename = assetDisplayName({
    prompt: asset.prompt,
    kind: asset.kind,
    mimeType: asset.mimeType,
    publicId: asset.publicId,
    displayName: metadataDisplayName(asset.metadata),
  });
  const disposition = assetDispositionType(asset.mimeType);

  return {
    body: obj.body,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    contentDisposition: contentDispositionHeader(disposition, filename),
  };
}

/** Pull a generator-supplied clean title out of the asset's metadata bag. */
function metadataDisplayName(metadata: unknown): string | null {
  if (metadata && typeof metadata === "object" && "displayName" in metadata) {
    const value = (metadata as { displayName?: unknown }).displayName;
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}
