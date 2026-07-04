import { NextResponse } from "next/server";
import {
  ASSET_LIMITS,
  assertAllowedAssetType,
  type AssetKind as StorageAssetKind,
} from "@oxagen/storage";
import { persistGeneratedAsset } from "@oxagen/handlers";
import { getSession } from "@/lib/session";
import { resolveWorkspaceScope } from "@/lib/resolve-org";

// Multipart uploads stream a real binary body and the persistence path uses
// Node crypto + the Vercel Blob SDK (via persistGeneratedAsset) — same
// constraints as the avatar upload route.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The chat composer only ever attaches these three kinds — "avatar" has no
// generated_assets analog (see asset.upload's `source` doc) and is out of
// scope for chat attachments.
const ATTACHMENT_KINDS = new Set<StorageAssetKind>(["image", "video", "document"]);
type AttachmentKind = "image" | "video" | "document";

function isAttachmentKind(value: unknown): value is AttachmentKind {
  return typeof value === "string" && ATTACHMENT_KINDS.has(value as StorageAssetKind);
}

/**
 * POST /api/v1/upload/attachment
 *
 * Accepts `multipart/form-data` with:
 *   - `file`           — required, the attachment bytes.
 *   - `kind`           — required, one of "image" | "video" | "document".
 *   - `workspaceId`    — required; orgId + membership are resolved server-side
 *                        from it (mirrors `plugin/catalog/get`'s pattern — the
 *                        chat composer only has slugs client-side historically,
 *                        but every other multipart-free API route in this app
 *                        that isn't itself under `/[orgSlug]/[workspaceSlug]`
 *                        resolves tenancy from a client-carried workspaceId, so
 *                        this route follows that seam rather than inventing a
 *                        slug-based one).
 *   - `conversationId` — optional; links the asset to a conversation so it
 *                        appears in `conversation.files.list` immediately.
 *
 * Stores the upload via the vendor-neutral storage adapter (private access —
 * NEVER a publicly-guessable blob URL) and records a `content.generated_assets`
 * row with `source: "user_upload"` via `persistGeneratedAsset` — the same
 * chokepoint every generation path uses, so blob + DB provenance never drift.
 *
 * Returns a `conversationAssetItem`-compatible JSON body so the client can
 * feed the response straight into the composer's pending-attachment state and
 * the conversation files panel without reshaping it.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  const rawKind = form.get("kind");
  if (!isAttachmentKind(rawKind)) {
    return NextResponse.json(
      { error: "kind must be one of: image, video, document" },
      { status: 400 },
    );
  }
  const kind: AttachmentKind = rawKind;

  const workspaceId = form.get("workspaceId");
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return NextResponse.json({ error: "Missing workspaceId" }, { status: 400 });
  }

  const rawConversationId = form.get("conversationId");
  const conversationId =
    typeof rawConversationId === "string" && rawConversationId.length > 0
      ? rawConversationId
      : null;

  // Tenant + membership gate — apps/app does NOT bootstrap kernel IAM
  // (invoke() skips it here), so this route asserts membership explicitly
  // before touching any org-scoped storage or DB write (IDOR guard).
  const scope = await resolveWorkspaceScope(workspaceId, session.user.id);
  if (!scope) {
    return NextResponse.json(
      { error: "Workspace not found or access denied" },
      { status: 404 },
    );
  }

  let ext: string;
  try {
    ext = assertAllowedAssetType(kind, file.type);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unsupported file type";
    return NextResponse.json({ error: message }, { status: 415 });
  }
  void ext; // extension is re-derived from mimeType inside persistGeneratedAsset

  if (file.size === 0) {
    return NextResponse.json({ error: "File is empty" }, { status: 400 });
  }
  const limit = ASSET_LIMITS[kind];
  if (file.size > limit) {
    const limitMb = Math.round(limit / (1024 * 1024));
    return NextResponse.json(
      { error: `File exceeds the ${limitMb} MB limit for ${kind} attachments` },
      { status: 413 },
    );
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const asset = await persistGeneratedAsset({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      userId: session.user.id,
      kind,
      source: "user_upload",
      // "org" so teammates viewing a shared conversation can see the
      // attachment, matching the chat composer's generated-media policy.
      accessPolicy: "org",
      bytes,
      mimeType: file.type,
      prompt: "",
      model: "",
      displayName: file.name || null,
      conversationId,
    });

    return NextResponse.json(
      {
        publicId: asset.publicId,
        kind: asset.kind,
        name: file.name || asset.publicId,
        mimeType: asset.mimeType,
        url: asset.serveUrl,
        sizeBytes: asset.sizeBytes,
      },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    const status = message.includes("BLOB_READ_WRITE_TOKEN") ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
