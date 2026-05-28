import { eq, and, desc } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { resolveTenant, resolveWorkspace } from "@/lib/resolve-tenant";
import { getSessionOrRedirect } from "@/lib/session";
import { ChatShell, type ChatMessage } from "@/components/chat/chat-shell";
import { sendMessageAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{ c?: string }>;
}) {
  const session = await getSessionOrRedirect();
  const [{ tenantSlug, workspaceSlug }, { c: conversationPublicId }] = await Promise.all([
    params,
    searchParams,
  ]);
  const tenant = await resolveTenant(tenantSlug);
  const workspace = await resolveWorkspace(tenant.id, workspaceSlug);

  const tables = schema as unknown as Record<string, any>;
  let conversationId: string | null = null;
  let activeLeafMessageId: string | null = null;

  if (tables.conversations) {
    const conv = conversationPublicId
      ? (
          await db()
            .select()
            .from(tables.conversations)
            .where(
              and(
                eq(tables.conversations.publicId, conversationPublicId),
                eq(tables.conversations.tenantId, tenant.id),
                eq(tables.conversations.workspaceId, workspace.id),
              ),
            )
            .limit(1)
        )[0]
      : (
          await db()
            .select()
            .from(tables.conversations)
            .where(
              and(
                eq(tables.conversations.userId, session.user.id),
                eq(tables.conversations.workspaceId, workspace.id),
              ),
            )
            .orderBy(desc(tables.conversations.createdAt))
            .limit(1)
        )[0];
    if (conv) {
      conversationId = conv.id;
      activeLeafMessageId = conv.activeLeafMessageId ?? null;
    }
  }

  // Promise lifts the message query into the RSC stream — the composer
  // renders eagerly while the active-branch walk resolves.
  const messagesPromise = (async (): Promise<ChatMessage[]> => {
    if (!conversationId || !tables.messages) return [];
    const rows = await db()
      .select()
      .from(tables.messages)
      .where(eq(tables.messages.conversationId, conversationId))
      .orderBy(desc(tables.messages.createdAt));
    return walkActiveBranch(rows, activeLeafMessageId);
  })();

  const sendAction = sendMessageAction.bind(null, {
    tenantSlug,
    workspaceSlug,
    tenantId: tenant.id,
    workspaceId: workspace.id,
  });

  return (
    <div className="mx-auto h-full max-w-4xl">
      <ChatShell
        conversationId={conversationId}
        activeLeafMessageId={activeLeafMessageId}
        messagesPromise={messagesPromise}
        sendAction={sendAction}
      />
    </div>
  );
}

// Walk parents from the active leaf to reconstruct the visible branch.
// Falls back to the most-recent root path when no leaf is set.
function walkActiveBranch(rows: any[], leafId: string | null): ChatMessage[] {
  if (rows.length === 0) return [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const childCount = new Map<string, number>();
  for (const r of rows) {
    if (r.parentMessageId) childCount.set(r.parentMessageId, (childCount.get(r.parentMessageId) ?? 0) + 1);
  }
  const path: any[] = [];
  let cursor = leafId ? byId.get(leafId) : rows.find((r) => r.parentMessageId === null);
  while (cursor) {
    path.unshift(cursor);
    cursor = cursor.parentMessageId ? byId.get(cursor.parentMessageId) : null;
  }
  return path.map((r) => ({
    publicId: r.publicId,
    role: r.role,
    content: r.content,
    branchReason: r.branchReason,
    siblingCount: r.parentMessageId ? (childCount.get(r.parentMessageId) ?? 1) : 1,
  }));
}
