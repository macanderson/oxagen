// generated-asset.persist.ts — upload an asset to blob storage and record a
// `content.generated_assets` reference row in one call.
//
// ADR-043 removed the generation half of this table: image / video / document
// generation left with the runtime, and with them the asynchronous render path
// (`createPendingGeneratedAsset`, the `pending` → `ready` walk). What remains is
// the ATTACHMENT half — a human uploading a file into a conversation so the
// governance agent can reason over it, plus the PDF `conversation.export`
// renders — so every write through here is synchronous and lands `ready`.
//
// It is still the single seam for that write (`asset.upload`,
// `conversation.attachment.add`, `conversation.export`, the app's attachment
// upload route), so blob upload + DB provenance never drift between surfaces.

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
// Provenance discriminator mirroring generated_assets_source_check. The column
// keeps both values so historical rows still read back, but the only writer left
// is the upload path — `conversation.export` is the sole caller that still
// passes "generated", for the PDF it renders on the user's behalf.
export type AssetSource = "generated" | "user_upload";

export interface PersistGeneratedAssetArgs {
  orgId: string;
  workspaceId: string;
  /** The owning user (drives the `user` access policy). */
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
  /** Provenance label. "" for a plain upload — there is no prompt behind it. */
  prompt: string;
  /** Provenance label. "" for a plain upload — no model produced it. */
  model: string;
  /**
   * A clean, human-readable title for the asset (e.g. the document title),
   * persisted to `metadata.displayName` and preferred over the prompt when
   * deriving the user-facing filename. Optional.
   */
  displayName?: string | null;
  /** Optional linkage to the chat turn that produced the asset. */
  conversationId?: string | null;
  messageId?: string | null;
  /**
   * Provenance discriminator. Defaults to `"generated"` so historical rows and
   * the `conversation.export` PDF keep their existing label; `asset.upload` and
   * `conversation.attachment.add` pass `"user_upload"`.
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
  /** Canonical storage key the object was written under (e.g. `generated/documents/org-1/uuid.pdf`). */
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
 * The composer upload path passes `conversationId` directly; a caller that only
 * carries `ctx.messageId` would otherwise write `conversation_id = NULL` and the
 * file would never appear in the panel. Resolving the message's conversation
 * here, in the single persistence chokepoint, covers every caller at once.
 *
 * Returns the explicit `conversationId` when supplied; otherwise the message's
 * conversation; otherwise null. Never throws — a generation must not fail just
 * because the linkage can't be resolved.
 *
 * Callers pass `conversationId` in one of two shapes: the internal UUID (the
 * chat stream route, which already holds the row) or the client-facing public
 * id ("cnv_…" — the composer upload path forwards it straight from the form).
 * The `conversation_id` uuid column rejects a public id outright, so the public
 * shape is resolved here, filtered on `orgId` — a forged "cnv_…" can never link
 * an asset into another org's conversation.
 *
 * Two lookups here are NOT org-filtered and rely on the caller for scoping: an
 * internal-UUID `conversationId` is trusted verbatim, and the `messageId` →
 * conversation lookup matches on message id alone. Both ids are kernel-supplied
 * (ctx.messageId / a row the route already read in scope) rather than raw user
 * input, but neither is verified against `orgId` in this function.
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
 * how to surface that.
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
  // kernel handlers and apps/app route handlers; the app's attachment-upload
  // route calls this OUTSIDE any runInTenantScope, so orgId/workspaceId are
  // carried explicitly in args as defense-in-depth) (see docs/specs/tenancy-rls/spec.md)
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
