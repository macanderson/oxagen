// generated-asset.persist.ts — upload AI-generated media to blob storage and
// record a `content.generated_assets` reference row in one call.
//
// This is the single seam every generation path (the chat composer's
// image/video intent, the image.generate/video.generate capabilities, the
// async video-render Inngest job) uses to durably store an asset, so blob
// upload + DB provenance never drift between surfaces (no-drift). It lives in
// packages/handlers alongside file.serve so the storage + db wiring is shared
// identically by apps/app, apps/api, and the inngest workers.

import { randomUUID } from "node:crypto";
import { schema, withSystemDb } from "@oxagen/database";
import { storage } from "@oxagen/storage";

export type AssetKind = "image" | "video";
export type AssetAccessPolicy = "user" | "org" | "public";

export interface PersistGeneratedAssetArgs {
  orgId: string;
  workspaceId: string;
  /** The user who generated the asset (ownership + the `user` access policy). */
  userId: string;
  kind: AssetKind;
  /**
   * Visibility. Defaults to the column default `user` (private to the creator).
   * The chat composer path passes `org` so teammates viewing the shared
   * conversation can see the asset today.
   */
  accessPolicy?: AssetAccessPolicy;
  /** Raw asset bytes to upload. */
  bytes: Uint8Array;
  /** MIME type, e.g. "image/png" or "video/mp4". Drives the storage key extension. */
  mimeType: string;
  /** The generation prompt (provenance). */
  prompt: string;
  /** The resolved gateway model id (provenance). */
  model: string;
  /** Optional linkage to the chat turn that produced the asset. */
  conversationId?: string | null;
  messageId?: string | null;
}

export interface PersistedGeneratedAsset {
  /** Internal UUID. */
  id: string;
  /** User-facing id ("gen_…") used in URLs and the serving route. */
  publicId: string;
  kind: AssetKind;
  mimeType: string;
  sizeBytes: number;
  /** Raw public blob URL (storageUrl). Prefer `serveUrl` for access-controlled display. */
  url: string;
  /** App serving path that enforces the asset's access policy. */
  serveUrl: string;
}

// Minimal MIME → extension map for the storage key. Unknown types fall back to
// a generic `.bin`; the stored mimeType column remains authoritative.
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

function extFor(mimeType: string): string {
  const type = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXT_BY_MIME[type] ?? "bin";
}

/**
 * Upload `bytes` to blob storage and insert a `generated_assets` row referencing
 * it (status `ready`). Returns the ids + the access-controlled serving URL the
 * UI should render. Throws if the upload or insert fails — the caller decides
 * how to surface that (e.g. the chat route emits an image-preview placeholder).
 */
export async function persistGeneratedAsset(
  args: PersistGeneratedAssetArgs,
): Promise<PersistedGeneratedAsset> {
  const key = `generated/${args.kind}s/${args.orgId}/${randomUUID()}.${extFor(args.mimeType)}`;
  const store = storage();
  const { url, key: storageKey, bytes } = await store.put({
    key,
    body: args.bytes,
    contentType: args.mimeType,
    access: "public",
  });

  // tenancy: system bypass via withSystemDb (shared utility called from both
  // kernel handlers and apps/app chat stream route; the chat stream route calls
  // this OUTSIDE any runInTenantScope — the image/video generation happens in a
  // ReadableStream callback that is not wrapped by the kernel or tenant scope;
  // orgId/workspaceId are carried explicitly in args as defense-in-depth) — OXA-1515
  const [row] = await withSystemDb((tx) =>
    tx
      .insert(schema.generatedAssets)
      .values({
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        userId: args.userId,
        createdByUserId: args.userId,
        updatedByUserId: args.userId,
        kind: args.kind,
        accessPolicy: args.accessPolicy ?? "user",
        status: "ready",
        storageProvider: store.driver,
        storageKey,
        storageUrl: url,
        mimeType: args.mimeType,
        sizeBytes: BigInt(bytes),
        prompt: args.prompt,
        model: args.model,
        conversationId: args.conversationId ?? undefined,
        messageId: args.messageId ?? undefined,
      })
      .returning({ id: schema.generatedAssets.id, publicId: schema.generatedAssets.publicId }),
  );

  if (!row) throw new Error("generated_assets insert failed");

  return {
    id: row.id,
    publicId: row.publicId,
    kind: args.kind,
    mimeType: args.mimeType,
    sizeBytes: bytes,
    url,
    serveUrl: `/api/v1/assets/${row.publicId}`,
  };
}

export interface CreatePendingGeneratedAssetArgs {
  orgId: string;
  workspaceId: string;
  userId: string;
  kind: AssetKind;
  accessPolicy?: AssetAccessPolicy;
  /** Expected MIME of the eventual asset (e.g. "video/mp4"). */
  mimeType: string;
  prompt: string;
  model: string;
  conversationId?: string | null;
  messageId?: string | null;
}

export interface PendingGeneratedAsset {
  /** Internal UUID — pass this as the Inngest render job's `assetId`. */
  id: string;
  /** User-facing id ("gen_…") used in URLs and the serving route. */
  publicId: string;
  /** App serving path; returns 404 until the async render marks the row `ready`. */
  serveUrl: string;
}

/**
 * Insert a `generated_assets` row in the `pending` state for an asynchronous
 * render (video). The blob doesn't exist yet, so `storageKey` is empty and
 * `storageUrl`/`sizeBytes` are null until the render job (the
 * `agent/video.render` Inngest function) uploads the result and flips the row to
 * `ready`. Returns the internal id (for the render job) and the serving URL the
 * UI polls.
 */
export async function createPendingGeneratedAsset(
  args: CreatePendingGeneratedAssetArgs,
): Promise<PendingGeneratedAsset> {
  // tenancy: system bypass via withSystemDb (same rationale as
  // persistGeneratedAsset — called from the chat stream route outside any
  // runInTenantScope; orgId/workspaceId are explicit in args) — OXA-1515
  const [row] = await withSystemDb((tx) =>
    tx
      .insert(schema.generatedAssets)
      .values({
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        userId: args.userId,
        createdByUserId: args.userId,
        updatedByUserId: args.userId,
        kind: args.kind,
        accessPolicy: args.accessPolicy ?? "user",
        status: "pending",
        storageProvider: storage().driver,
        storageKey: "",
        mimeType: args.mimeType,
        prompt: args.prompt,
        model: args.model,
        conversationId: args.conversationId ?? undefined,
        messageId: args.messageId ?? undefined,
      })
      .returning({ id: schema.generatedAssets.id, publicId: schema.generatedAssets.publicId }),
  );

  if (!row) throw new Error("generated_assets pending insert failed");

  return { id: row.id, publicId: row.publicId, serveUrl: `/api/v1/assets/${row.publicId}` };
}
