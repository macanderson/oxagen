// GET /api/v1/conversations/[conversationId]/export?format=markdown|pdf
//
// Thin adapter over the wired `conversation.export` capability so serialization,
// PDF rendering, and access checks live in exactly one place
// (packages/handlers/src/conversation.export.ts) and metering + IAM flow
// through invoke() — no duplicated logic in the app layer. Mirrors the sibling
// assets route's access-control pattern:
//   - Session user must be authenticated.
//   - The conversation's org + workspace are resolved server-side from the row
//     (Next.js route handlers have no ALS tenant scope), then validated against
//     the caller's org membership before invoking the capability. The capability
//     handler re-checks the conversation is in scope (defense in depth).
//
// Response: the ConversationExportOutput JSON envelope
//   { format, filename, content (markdown only), url (pdf only), messageCount }.

import { eq, and, isNull } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import type { ConversationExportOutput } from "@oxagen/oxagen/contracts/conversation.export";
import { getSession } from "@/lib/session";

// Node runtime: uses crypto + DB + pdf-lib.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ conversationId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 });
  }
  const userId = session.user.id;
  const { conversationId } = await ctx.params;

  const format = new URL(req.url).searchParams.get("format");
  if (format !== "markdown" && format !== "pdf") {
    return Response.json(
      { error: 'Invalid format — use "markdown" or "pdf"' },
      { status: 400 },
    );
  }

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
    const out = (await invoke(
      "conversation.export",
      { conversationId, format },
      capabilityCtx,
      { surface: "api" },
    )) as ConversationExportOutput;
    return Response.json(out);
  } catch (err) {
    // The handler throws "conversation not found" when out of scope; surface 404.
    const message = err instanceof Error ? err.message : "Export failed";
    if (message.includes("not found")) {
      return new Response("Not Found", { status: 404 });
    }
    return Response.json({ error: message }, { status: 500 });
  }
}
