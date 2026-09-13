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

/**
 * Structured outcome of a current-turn media resolve, so the caller can tell
 * the THREE distinct failure modes apart instead of collapsing them into a
 * single "row absent" 422 (the historical P0: an attachment that existed but
 * whose bytes momentarily failed to fetch was blamed on the user with a
 * "remove and re-attach" message — see route.ts).
 *
 *   - `resolved`  — publicId → bytes+kind, ready to send to the model.
 *   - `notFound`  — requested publicIds with no matching DB row (unknown,
 *                   foreign org/workspace, non-media kind, not `ready`, or
 *                   soft-deleted). A genuine, user-fixable 422.
 *   - `fetchFailed` — publicIds whose DB row WAS found but whose blob bytes
 *                   could not be fetched (transient storage error). NOT the
 *                   user's fault — a retryable 502, never "re-attach".
 */
export interface ResolveAttachmentMediaResult {
  resolved: Map<string, ResolvedAttachmentMedia>;
  notFound: string[];
  fetchFailed: string[];
}

/** Drain a private-blob ReadableStream into a Buffer (same pattern as
 * `packages/agent/src/handlers/agent.feature.verify.ts`'s judge-image fetch —
 * duplicated locally since it's a tiny, dependency-free helper and the two
 * call sites live in different packages). */
async function streamToBuffer(
  stream: ReadableStream<Uint8Array>,
): Promise<Buffer> {
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
  return (await resolveAttachmentMediaDetailed(publicIds, scope)).resolved;
}

/**
 * Diagnostic-rich variant of {@link resolveAttachmentMedia}. Returns the
 * resolved bytes PLUS which requested ids had no DB row (`notFound`) and which
 * had a row but failed to fetch their bytes (`fetchFailed`). The route uses the
 * split to return the CORRECT status: a 422 only when a row is genuinely
 * missing, a retryable 502 when a real asset's bytes momentarily failed. A
 * per-id fetch error no longer rejects the whole batch (one bad blob used to
 * turn every attachment on the turn into a 500 or a misleading 422).
 */
export async function resolveAttachmentMediaDetailed(
  publicIds: string[],
  scope: { orgId: string; workspaceId: string },
): Promise<ResolveAttachmentMediaResult> {
  if (publicIds.length === 0) {
    return { resolved: new Map(), notFound: [], fetchFailed: [] };
  }

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

  // Ids the scoped DB query never returned are genuinely not resolvable for
  // this tenant — unknown, foreign, wrong kind, not ready, or soft-deleted.
  const foundIds = new Set(rows.map((r) => r.publicId));
  const notFound = publicIds.filter((id) => !foundIds.has(id));

  const resolved = new Map<string, ResolvedAttachmentMedia>();
  const fetchFailed: string[] = [];

  // Fetch each row's bytes independently. A single unreadable blob is isolated
  // to `fetchFailed` (retryable) instead of rejecting the whole Promise.all and
  // taking every sibling attachment down with it.
  await Promise.all(
    rows.map(async (row) => {
      try {
        const obj = await storage().get(row.storageKey);
        const data = await streamToBuffer(obj.body);
        resolved.set(row.publicId, {
          kind: row.kind === "video" ? "video" : "image",
          data,
          mediaType: row.mimeType,
        });
      } catch {
        fetchFailed.push(row.publicId);
      }
    }),
  );

  return { resolved, notFound, fetchFailed };
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
