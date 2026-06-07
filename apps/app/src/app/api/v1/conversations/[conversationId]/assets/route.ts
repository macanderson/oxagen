// GET /api/v1/conversations/[conversationId]/assets
//
// Returns the generated_assets associated with a given conversation, newest-first.
// Access control:
//   - Session user must be authenticated.
//   - The conversation must belong to an org the user is a member of.
//   - Assets with policy "user" are filtered to those owned by the requesting user.
//   - Assets with policy "org" or "public" are included for all org members.
//
// This route uses withSystemDb because there is no ALS tenant scope active in
// Next.js route handlers (only RSC invocations have one via conversation-page.tsx).
// The org-membership check is enforced in-code.
//
// Response: JSON array of ConversationAssetItem, ordered createdAt DESC.

import { eq, and, desc, inArray } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { getSession } from "@/lib/session";

// Node runtime: uses crypto + DB.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface ConversationAssetItem {
  publicId: string;
  kind: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  status: string;
  accessPolicy: string;
  createdAt: string;
  /** Access-controlled serving URL via the assets route. */
  url: string;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ conversationId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 });
  }
  const userId = session.user.id;
  const { conversationId } = await ctx.params;

  // Resolve the conversation row (system db — no ALS scope).
  const convRows = await withSystemDb((tx) =>
    tx
      .select({
        id: schema.conversations.id,
        orgId: schema.conversations.orgId,
      })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.publicId, conversationId),
          eq(schema.conversations.deletedAt, null),
        ),
      )
      .limit(1),
  );
  const conv = convRows[0];
  if (!conv) {
    return new Response("Not Found", { status: 404 });
  }

  // Verify the requesting user is a member of the conversation's org.
  const memberRows = await withSystemDb((tx) =>
    tx
      .select({ id: schema.orgUsers.id })
      .from(schema.orgUsers)
      .where(
        and(
          eq(schema.orgUsers.orgId, conv.orgId),
          eq(schema.orgUsers.userId, userId),
        ),
      )
      .limit(1),
  );
  if (memberRows.length === 0) {
    return new Response("Not Found", { status: 404 });
  }

  // Fetch assets for this conversation, all access policies.
  const assets = await withSystemDb((tx) =>
    tx
      .select({
        publicId: schema.generatedAssets.publicId,
        kind: schema.generatedAssets.kind,
        mimeType: schema.generatedAssets.mimeType,
        sizeBytes: schema.generatedAssets.sizeBytes,
        status: schema.generatedAssets.status,
        accessPolicy: schema.generatedAssets.accessPolicy,
        userId: schema.generatedAssets.userId,
        prompt: schema.generatedAssets.prompt,
        createdAt: schema.generatedAssets.createdAt,
      })
      .from(schema.generatedAssets)
      .where(
        and(
          eq(schema.generatedAssets.conversationId, conv.id),
          eq(schema.generatedAssets.deletedAt, null),
          eq(schema.generatedAssets.status, "ready"),
          // "image" and "video" are rendered by dedicated components; include
          // all kinds here so the files-list panel is comprehensive.
          inArray(schema.generatedAssets.kind, [
            "image",
            "video",
            "document",
            "spreadsheet",
            "presentation",
            "pdf",
            "archive",
          ]),
        ),
      )
      .orderBy(desc(schema.generatedAssets.createdAt)),
  );

  // Apply access-policy filter:
  //   public / org  → visible to any org member (already verified above)
  //   user          → visible only to the asset's creator
  const visible = assets.filter(
    (a) => a.accessPolicy !== "user" || a.userId === userId,
  );

  const items: ConversationAssetItem[] = visible.map((a) => ({
    publicId: a.publicId,
    kind: a.kind,
    // Derive a display name: prefer the prompt's first sentence (≤60 chars),
    // falling back to "kind-publicId".
    name: deriveAssetName(a.kind, a.prompt, a.publicId),
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes !== null ? Number(a.sizeBytes) : null,
    status: a.status,
    accessPolicy: a.accessPolicy,
    createdAt: a.createdAt.toISOString(),
    // Serve via the access-controlled asset route (our own origin).
    url: `/api/v1/assets/${a.publicId}`,
  }));

  return Response.json(items);
}

/**
 * Derive a human-readable name for an asset from its generation prompt.
 * Falls back to "<kind>-<publicId-suffix>" when the prompt is missing.
 */
function deriveAssetName(
  kind: string,
  prompt: string,
  publicId: string,
): string {
  if (prompt.trim().length > 0) {
    // Take the first sentence or first 60 chars of the prompt.
    const sentence = prompt.split(/[.!?\n]/)[0]?.trim() ?? prompt;
    const label = sentence.length > 60 ? `${sentence.slice(0, 57)}…` : sentence;
    if (label.length > 0) {
      // Append a kind suffix so the file type is clear.
      const ext = kindExtension(kind);
      return ext ? `${label}${ext}` : label;
    }
  }
  return `${kind}-${publicId.slice(-8)}`;
}

function kindExtension(kind: string): string {
  switch (kind) {
    case "image": return "";
    case "video": return "";
    case "pdf": return ".pdf";
    case "document": return ".docx";
    case "spreadsheet": return ".xlsx";
    case "presentation": return ".pptx";
    case "archive": return ".zip";
    default: return "";
  }
}
