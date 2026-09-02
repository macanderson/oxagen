// GET /api/v1/conversations/[conversationId]/assets/archive
//
// Streams every generated asset attached to the conversation as ONE ZIP
// download — the "Download all" affordance the Files tab shows once a
// conversation has more than one file.
//
// Thin adapter, same shape as the sibling assets-list route:
//   1. Session auth + org-membership check (identical IDOR guard).
//   2. The file list comes from the wired `list_conversation_files` capability,
//      so access-policy filtering, metering and IAM flow through invoke() —
//      the ZIP can only ever contain files the list endpoint would have shown.
//   3. Zip assembly is raw data access (not a kernel capability, same class as
//      /api/v1/assets/[assetId]): archiveGeneratedAssets() re-fetches each
//      entry through serveGeneratedAsset(), re-enforcing the per-asset access
//      policy and emitting per-file serve telemetry.
//
// Response: application/zip attachment named after the conversation title.

import { eq, and, isNull } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { archiveGeneratedAssets } from "@oxagen/handlers";
import type { ConversationAssetItem } from "@oxagen/oxagen/contracts/conversation.files.list";
import { getSession } from "@/lib/session";

// Default Node.js runtime: uses crypto + DB + blob streaming — never move to
// edge. No `export const runtime` (incompatible with cacheComponents; Node is
// the framework default).

/** ASCII-safe, header-safe archive filename derived from the conversation title. */
function archiveFilename(title: string | null, conversationId: string): string {
  const slug = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || conversationId}-files.zip`;
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

  // Resolve the conversation's org + workspace (system db — no ALS scope here).
  const convRows = await withSystemDb((tx) =>
    tx
      .select({
        orgId: schema.conversations.orgId,
        workspaceId: schema.conversations.workspaceId,
        title: schema.conversations.title,
      })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.publicId, conversationId),
          isNull(schema.conversations.deletedAt),
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

  const requestId = crypto.randomUUID();
  const capabilityCtx = {
    orgId: conv.orgId,
    workspaceId: conv.workspaceId,
    userId,
    apiKeyId: null as string | null,
    requestId,
    surface: "app" as const,
    messageId: null as string | null,
  };

  let files: ConversationAssetItem[];
  try {
    const out = await invoke(
      "list_conversation_files",
      { conversationId, kind: undefined, limit: 200, cursor: null },
      capabilityCtx,
      { surface: "api" },
    );
    files = (out as { files: ConversationAssetItem[] }).files;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list files";
    if (message.includes("not found")) {
      return new Response("Not Found", { status: 404 });
    }
    return Response.json({ error: message }, { status: 500 });
  }

  if (files.length === 0) {
    // Nothing to archive — the UI only offers the ZIP when files exist, so a
    // bare 404 here only meets hand-typed URLs.
    return new Response("Not Found", { status: 404 });
  }

  const body = archiveGeneratedAssets(
    files.map((f) => ({
      publicId: f.publicId,
      name: f.name,
      mimeType: f.mimeType,
    })),
    { userId, surface: "app", requestId },
  );

  const filename = archiveFilename(conv.title, conversationId);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "cache-control": "private, max-age=0, must-revalidate",
      "content-disposition": `attachment; filename="${filename}"`,
      "x-content-type-options": "nosniff",
    },
  });
}
