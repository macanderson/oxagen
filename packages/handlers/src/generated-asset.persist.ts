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
import { and, eq } from "drizzle-orm";
import { schema, withSystemDb, type Tx } from "@oxagen/database";
import { storage } from "@oxagen/storage";

export type AssetKind =
  | "image"
  | "video"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "pdf"
  | "archive";
export type AssetAccessPolicy = "user" | "org" | "public";
// Provenance discriminator mirroring generated_assets_source_check.
// 'generated' (default) = produced by the in-app agent; 'user_upload' = a
// chat/agent attachment the user supplied via asset.upload.
export type AssetSource = "generated" | "user_upload";

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
  /**
   * A clean, human-readable title for the asset (e.g. the document title),
   * persisted to `metadata.displayName` and preferred over the prompt when
   * deriving the user-facing filename. Optional — image generators leave this
   * unset and let the prompt drive the name.
   */
  displayName?: string | null;
  /** Optional linkage to the chat turn that produced the asset. */
  conversationId?: string | null;
  messageId?: string | null;
  /**
   * Provenance discriminator. Defaults to `"generated"` (every existing
   * caller — image/video generation, the chat composer) so this is fully
   * backward compatible. `asset.upload` passes `"user_upload"` for
   * chat/agent attachments the user supplied rather than the model.
   */
  source?: AssetSource;
}

export interface PersistedGeneratedAsset {
  /** Internal UUID. */
  id: string;
  /** User-facing id ("gen_…") used in URLs and the serving route. */
  publicId: string;
  kind: AssetKind;
  mimeType: string;
  sizeBytes: number;
  /** Canonical storage key the object was written under (e.g. `generated/images/org-1/uuid.png`). */
  key: string;
  /**
   * The storage URL (Vercel Blob URL or private access URL) as returned by the
   * adapter. For private assets this is NOT a publicly-guessable CDN URL.
   * Always prefer `serveUrl` for rendering in the UI.
   */
  url: string;
  /** App serving path that enforces the asset's access policy. Always use this for display. */
  serveUrl: string;
}

// Minimal MIME → extension map for the storage key. Unknown types fall back to
// a generic `.bin`; the stored mimeType column remains authoritative.
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  // document kinds
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "text/markdown": "md",
  "text/plain": "txt",
  // Mermaid diagram source (mermaid.generate persists the .mmd source — the
  // rendered SVG only ever exists client-side).
  "text/vnd.mermaid": "mmd",
};

function extFor(mimeType: string): string {
  const type = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXT_BY_MIME[type] ?? "bin";
}

/**
 * Build the `metadata` jsonb for an asset row. Stores the generator-supplied
 * clean title under `displayName` so the serving route + Conversation Files
 * panel can render a human-readable filename without re-deriving it from the
 * noisy prompt. Returns undefined (column default) when there's nothing to set.
 */
function buildMetadata(
  displayName: string | null | undefined,
): { displayName: string } | undefined {
  const name = displayName?.trim();
  return name ? { displayName: name } : undefined;
}

/**
 * Resolve the conversation an asset belongs to so the Conversation Files panel
 * (`conversation.files.list`, which filters `generated_assets.conversation_id`)
 * can find it.
 *
 * The chat composer's image/video path passes `conversationId` directly, but the
 * agent-tool generators (documents/markdown/archive/image.create/video.generate)
 * only carry `ctx.messageId` — never the conversation id. Without this seam those
 * assets were written with `conversation_id = NULL` and never appeared in the
 * panel. Resolving the message's conversation here, in the single persistence
 * chokepoint, fixes every generator at once (no per-handler plumbing).
 *
 * Returns the explicit `conversationId` when supplied; otherwise the message's
 * conversation; otherwise null. Never throws — a generation must not fail just
 * because the linkage can't be resolved.
 *
 * Callers pass `conversationId` in one of two shapes: the internal UUID (the
 * chat stream route, which already holds the row) or the client-facing public
 * id ("cnv_…" — the composer upload path forwards it straight from the form).
 * The `conversation_id` uuid column rejects a public id outright (every
 * composer upload into an active conversation 500'd), so the public shape is
 * resolved here — org-scoped, so a forged id can never link an asset into
 * another org's conversation.
 */
async function resolveConversationId(
  tx: Tx,
  orgId: string,
  conversationId: string | null | undefined,
  messageId: string | null | undefined,
): Promise<string | null> {
  if (conversationId) {
    if (!conversationId.startsWith("cnv_")) return conversationId;
    const [conv] = await tx
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.publicId, conversationId),
          eq(schema.conversations.orgId, orgId),
        ),
      )
      .limit(1);
    return conv?.id ?? null;
  }
  if (!messageId) return null;
  const [msg] = await tx
    .select({ conversationId: schema.messages.conversationId })
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .limit(1);
  return msg?.conversationId ?? null;
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
  // Store as private blobs; the CDN URL must never be publicly guessable.
  // Access is served exclusively through the auth-gated /api/v1/assets/[publicId]
  // proxy which enforces the asset's access policy before returning the blob.
  const {
    url,
    key: storageKey,
    bytes,
  } = await store.put({
    key,
    body: args.bytes,
    contentType: args.mimeType,
    access: "private",
  });

  // tenancy: system bypass via withSystemDb (shared utility called from both
  // kernel handlers and apps/app chat stream route; the chat stream route calls
  // this OUTSIDE any runInTenantScope — the image/video generation happens in a
  // ReadableStream callback that is not wrapped by the kernel or tenant scope;
  // orgId/workspaceId are carried explicitly in args as defense-in-depth) (see docs/specs/tenancy-rls/spec.md)
  const [row] = await withSystemDb(async (tx) => {
    const conversationId = await resolveConversationId(
      tx,
      args.orgId,
      args.conversationId,
      args.messageId,
    );
    return tx
      .insert(schema.generatedAssets)
      .values({
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        userId: args.userId,
        createdByUserId: args.userId,
        updatedByUserId: args.userId,
        kind: args.kind,
        source: args.source ?? "generated",
        accessPolicy: args.accessPolicy ?? "user",
        status: "ready",
        storageProvider: store.driver,
        storageKey,
        storageUrl: url,
        mimeType: args.mimeType,
        sizeBytes: BigInt(bytes),
        prompt: args.prompt,
        model: args.model,
        metadata: buildMetadata(args.displayName),
        conversationId: conversationId ?? undefined,
        messageId: args.messageId ?? undefined,
      })
      .returning({
        id: schema.generatedAssets.id,
        publicId: schema.generatedAssets.publicId,
      });
  });

  if (!row) throw new Error("generated_assets insert failed");

  return {
    id: row.id,
    publicId: row.publicId,
    kind: args.kind,
    mimeType: args.mimeType,
    sizeBytes: bytes,
    key: storageKey,
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
  /** Clean human-readable title persisted to `metadata.displayName` (see persist). */
  displayName?: string | null;
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
  // runInTenantScope; orgId/workspaceId are explicit in args) (see docs/specs/tenancy-rls/spec.md)
  const [row] = await withSystemDb(async (tx) => {
    const conversationId = await resolveConversationId(
      tx,
      args.orgId,
      args.conversationId,
      args.messageId,
    );
    return tx
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
        metadata: buildMetadata(args.displayName),
        conversationId: conversationId ?? undefined,
        messageId: args.messageId ?? undefined,
      })
      .returning({
        id: schema.generatedAssets.id,
        publicId: schema.generatedAssets.publicId,
      });
  });

  if (!row) throw new Error("generated_assets pending insert failed");

  return {
    id: row.id,
    publicId: row.publicId,
    serveUrl: `/api/v1/assets/${row.publicId}`,
  };
}
