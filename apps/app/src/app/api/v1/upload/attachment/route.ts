import { NextResponse } from "next/server";
import {
  ASSET_LIMITS,
  assertAllowedAssetType,
  type AssetKind as StorageAssetKind,
} from "@oxagen/storage";
import {
  persistGeneratedAsset,
  type AssetKind as GeneratedAssetKind,
} from "@oxagen/handlers";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";

// Chat/agent attachment upload runs on the default Node.js runtime (the storage
// adapter uses Node crypto + the Vercel Blob SDK) and must never move to edge —
// every response reflects a brand-new, access-controlled asset row. No
// `export const runtime`: incompatible with cacheComponents (Node is default).

// Only "image" is wired to the composer in Phase 1 (video/document upload UI
// is deferred — see multimodal blueprint Phase 2). Restricted to the
// intersection of @oxagen/storage's AssetKind (limits/MIME allowlist) and
// @oxagen/handlers' AssetKind (persistGeneratedAsset's kind union) so both
// casts below are sound; the route needs no change when a later phase adds
// video/document pickers.
type AttachmentKind = "image" | "document" | "video";
const ATTACHMENT_KINDS = new Set<AttachmentKind>([
  "image",
  "document",
  "video",
]);

/**
 * POST /api/v1/upload/attachment
 *
 * Accepts `multipart/form-data` with:
 *   - `file`           — the attachment bytes (required).
 *   - `kind`           — asset kind, one of "image" | "document" | "video"
 *                        (required). Drives the allowed MIME types + size
 *                        limit (shared with `asset.upload` via `@oxagen/storage`).
 *   - `orgSlug`        — org slug the attachment is scoped to (required).
 *   - `workspaceSlug`  — workspace slug the attachment is scoped to (required).
 *   - `conversationId` — public id of the conversation to link the asset to
 *                        (optional — a fresh composer has no conversation yet;
 *                        the stream route still resolves the attachment by
 *                        `publicId` regardless of linkage).
 *
 * Auth: the session user must be a member of the resolved org (IDOR guard —
 * mirrors the chat stream route's tenant resolution). Bytes are written ONLY
 * to blob storage (`access: "private"`); the `generated_assets` Postgres row
 * is the reference (four-store rule). The response is the `conversationAssetItem`
 * shape (`@oxagen/oxagen/contracts/conversation.files.list`) so the composer,
 * the stream route, and the Conversation Files panel all agree on one wire
 * shape for a chat attachment.
 *
 * Serving: the returned `url` is the access-controlled `/api/v1/assets/:publicId`
 * proxy — the private blob URL is never returned to the client.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let session: Awaited<ReturnType<typeof getSessionOrRedirect>>;
  try {
    session = await getSessionOrRedirect();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data" },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  const kindRaw = form.get("kind");
  const kindCandidate = typeof kindRaw === "string" ? kindRaw : "";
  if (!ATTACHMENT_KINDS.has(kindCandidate as AttachmentKind)) {
    return NextResponse.json(
      { error: 'Invalid kind — expected "image", "document", or "video"' },
      { status: 400 },
    );
  }
  // Narrowed by the membership check above — safe to treat as AttachmentKind
  // from here on, and it's structurally valid for both the @oxagen/storage
  // AssetKind (limits/MIME allowlist) and @oxagen/handlers AssetKind
  // (persistGeneratedAsset's kind union).
  const kind = kindCandidate as AttachmentKind;

  const orgSlug = form.get("orgSlug");
  const workspaceSlug = form.get("workspaceSlug");
  if (typeof orgSlug !== "string" || orgSlug.length === 0) {
    return NextResponse.json({ error: "Missing orgSlug" }, { status: 400 });
  }
  if (typeof workspaceSlug !== "string" || workspaceSlug.length === 0) {
    return NextResponse.json(
      { error: "Missing workspaceSlug" },
      { status: 400 },
    );
  }
  const conversationIdRaw = form.get("conversationId");
  const conversationId =
    typeof conversationIdRaw === "string" && conversationIdRaw.length > 0
      ? conversationIdRaw
      : null;

  let ext: string;
  try {
    ext = assertAllowedAssetType(kind as StorageAssetKind, file.type);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unsupported file type" },
      { status: 415 },
    );
  }
  // ext is only used for the validation above; the persistence chokepoint
  // derives its own storage-key extension from the MIME type.
  void ext;

  if (file.size === 0) {
    return NextResponse.json({ error: "File is empty" }, { status: 400 });
  }
  const limit = ASSET_LIMITS[kind as StorageAssetKind];
  if (file.size > limit) {
    const limitMb = (limit / (1024 * 1024)).toFixed(0);
    return NextResponse.json(
      {
        error: `File exceeds the ${limitMb} MiB limit for "${kind}" attachments`,
      },
      { status: 413 },
    );
  }

  // Membership gate: any authenticated user can submit a request naming any
  // org slug — assert they are actually a member before writing an
  // org-scoped asset row (IDOR guard, mirrors the chat stream route).
  let tenant: Awaited<ReturnType<typeof resolveOrg>>;
  let workspace: Awaited<ReturnType<typeof resolveWorkspace>>;
  try {
    tenant = await resolveOrg(orgSlug);
    const [, resolvedWorkspace] = await Promise.all([
      assertOrgMember(tenant.id, session.user.id),
      resolveWorkspace(tenant.id, workspaceSlug),
    ]);
    workspace = resolvedWorkspace;
  } catch {
    return NextResponse.json(
      { error: "Org or workspace not found" },
      { status: 404 },
    );
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const persisted = await persistGeneratedAsset({
      orgId: tenant.id,
      workspaceId: workspace.id,
      userId: session.user.id,
      kind: kind as GeneratedAssetKind,
      // Chat attachments are visible to any org member viewing the shared
      // conversation, matching the existing chat-composer generation path.
      accessPolicy: "org",
      bytes,
      mimeType: file.type,
      // User uploads have no generation prompt/model — the `source` column is
      // the provenance discriminator (see Phase 0 migration).
      prompt: "",
      model: "",
      // The browser's original filename is a far better display name than
      // anything derivable from an empty prompt.
      displayName: file.name || null,
      conversationId,
      source: "user_upload",
    });

    return NextResponse.json(
      {
        publicId: persisted.publicId,
        kind: persisted.kind,
        name: file.name || persisted.publicId,
        mimeType: persisted.mimeType,
        sizeBytes: persisted.sizeBytes,
        status: "ready",
        accessPolicy: "org",
        createdAt: new Date().toISOString(),
        url: persisted.serveUrl,
      },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    const status = message.includes("BLOB_READ_WRITE_TOKEN") ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
