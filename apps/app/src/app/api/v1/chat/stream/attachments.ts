// attachments.ts — resolve chat-turn image attachment publicIds to fetched
// bytes, org/workspace-scoped.
//
// Used by route.ts for two distinct purposes that share the same fetch
// primitive but react differently to a miss:
//   1. The CURRENT turn's attachments (BodySchema `attachments`) — a miss
//      (unknown/foreign id, wrong kind, not ready, deleted) is a hard 422:
//      the user explicitly attached something and the model must see it.
//   2. Bounded HISTORY replay (history.ts `collectRecentAttachmentPublicIds`)
//      — a miss silently degrades to a `[attached image: <name>]` text
//      placeholder; an image from three turns ago disappearing is not worth
//      failing the whole turn over.
//
// Bytes are fetched server-side via the private storage adapter and never
// leave this process as a URL — the model receives raw image bytes, the
// client never sees a blob URL (four-store rule: bytes stay in blob storage,
// refs flow by publicId).

import { and, eq, inArray, isNull } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { storage } from "@oxagen/storage";

export interface ResolvedAttachmentImage {
  data: Buffer;
  mediaType: string;
}

/** A resolved current-turn attachment, tagged with its stored kind so the
 * route can partition image vs. video parts (Phase 2). Video is only ever
 * sent to a video-capable model — see attachment-routing.ts. */
export interface ResolvedAttachmentMedia {
  kind: "image" | "video";
  data: Buffer;
  mediaType: string;
}

/** Drain a private-blob ReadableStream into a Buffer (same pattern as
 * `packages/agent/src/handlers/agent.feature.verify.ts`'s judge-image fetch —
 * duplicated locally since it's a tiny, dependency-free helper and the two
 * call sites live in different packages). */
async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Resolve `publicIds` to their fetched bytes for the two multimodal-input
 * kinds — `image` and `video`. Org/workspace-scoped (RLS via `runInTenantScope`
 * + explicit predicates) and restricted to `status: 'ready'`, non-deleted rows.
 * Each entry carries its stored `kind` so the caller can partition image vs.
 * video parts and route videos through the video/keyframe decision.
 *
 * Returns a Map keyed by publicId. An id that doesn't resolve (unknown,
 * foreign org, non-media kind, not ready, soft-deleted) is simply ABSENT from
 * the map — the caller decides whether that's a hard error or a silent degrade.
 */
export async function resolveAttachmentMedia(
  publicIds: string[],
  scope: { orgId: string; workspaceId: string },
): Promise<Map<string, ResolvedAttachmentMedia>> {
  if (publicIds.length === 0) return new Map();

  const rows = await runInTenantScope(scope, () =>
    withTenantDb((tx) =>
      tx
        .select({
          publicId: schema.generatedAssets.publicId,
          storageKey: schema.generatedAssets.storageKey,
          mimeType: schema.generatedAssets.mimeType,
          kind: schema.generatedAssets.kind,
        })
        .from(schema.generatedAssets)
        .where(
          and(
            inArray(schema.generatedAssets.publicId, publicIds),
            eq(schema.generatedAssets.orgId, scope.orgId),
            eq(schema.generatedAssets.workspaceId, scope.workspaceId),
            eq(schema.generatedAssets.status, "ready"),
            inArray(schema.generatedAssets.kind, ["image", "video"]),
            isNull(schema.generatedAssets.deletedAt),
          ),
        ),
    ),
  );

  const entries = await Promise.all(
    rows.map(async (row) => {
      const obj = await storage().get(row.storageKey);
      const data = await streamToBuffer(obj.body);
      return [
        row.publicId,
        {
          kind: row.kind === "video" ? "video" : "image",
          data,
          mediaType: row.mimeType,
        } as ResolvedAttachmentMedia,
      ] as const;
    }),
  );

  return new Map(entries);
}

/**
 * Resolve `publicIds` to their fetched image bytes — the image-only view over
 * {@link resolveAttachmentMedia}, used by bounded history replay (history.ts)
 * where only prior-turn images are re-materialized. Video and other kinds are
 * dropped (absent from the returned map). Same scoping + miss semantics as
 * `resolveAttachmentMedia`.
 */
export async function resolveAttachmentImages(
  publicIds: string[],
  scope: { orgId: string; workspaceId: string },
): Promise<Map<string, ResolvedAttachmentImage>> {
  const media = await resolveAttachmentMedia(publicIds, scope);
  const images = new Map<string, ResolvedAttachmentImage>();
  for (const [publicId, entry] of media) {
    if (entry.kind === "image") {
      images.set(publicId, { data: entry.data, mediaType: entry.mediaType });
    }
  }
  return images;
}
