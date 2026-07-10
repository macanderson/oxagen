// GET /api/v1/conversations/[conversationId]/assets
//
// Returns the generated_assets associated with a given conversation, newest-first.
// Thin adapter over the wired `conversation.files.list` capability so the query,
// access-policy filter, and display-name derivation live in exactly one place
// (packages/handlers/src/conversation.files.list.ts) and metering + IAM flow
// through invoke() — no duplicated SQL in the app layer.
//
// Access control:
//   - Session user must be authenticated.
//   - The conversation's org + workspace are resolved server-side from the row
//     (Next.js route handlers have no ALS tenant scope), then validated against
//     the caller's org membership before invoking the capability. The capability
//     handler re-checks the conversation is in scope (defense in depth).
//
// Response: JSON array of ConversationAssetItem, ordered createdAt DESC.

import { eq, and, isNull } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import type { ConversationAssetItem } from "@oxagen/oxagen/contracts/conversation.files.list";
import { getSession } from "@/lib/session";

// Re-export the canonical contract type so existing importers
// (conversation-files.tsx) keep a single source of truth.
export type { ConversationAssetItem };

// Default Node.js runtime: uses crypto + DB — never move to edge. No
// `export const runtime` (incompatible with cacheComponents; Node is default).

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

  const capabilityCtx = {
    orgId: conv.orgId,
    workspaceId: conv.workspaceId,
    userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  try {
    const out = await invoke(
      "list_conversation_files",
      { conversationId, kind: undefined, limit: 200, cursor: null },
      capabilityCtx,
      { surface: "api" },
    );
    // The drawer consumes a flat array of ConversationAssetItem.
    return Response.json((out as { files: ConversationAssetItem[] }).files);
  } catch (err) {
    // The handler throws "conversation not found" when out of scope; surface 404.
    const message = err instanceof Error ? err.message : "Failed to list files";
    if (message.includes("not found")) {
      return new Response("Not Found", { status: 404 });
    }
    return Response.json({ error: message }, { status: 500 });
  }
}
