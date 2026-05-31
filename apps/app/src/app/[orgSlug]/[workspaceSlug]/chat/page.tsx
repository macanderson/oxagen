import { eq, and, desc } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { ChatShell, type ChatMessage } from "@/components/chat/chat-shell";
import type { AgentCapability } from "@/components/chat/plan-card";
import { listCapabilities, getSurfaces } from "@oxagen/oxagen";
import {
  cancelBackgroundTaskAction,
  readBackgroundTaskAction,
  resolveApprovalAction,
  resolvePlanAction,
  sendMessageAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{ c?: string }>;
}) {
  const session = await getSessionOrRedirect();
  const [{ orgSlug, workspaceSlug }, { c: conversationPublicId }] = await Promise.all([
    params,
    searchParams,
  ]);
  const tenant = await resolveOrg(orgSlug);
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
                eq(tables.conversations.orgId, tenant.id),
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

  const actionCtx = {
    orgSlug,
    workspaceSlug,
    orgId: tenant.id,
    workspaceId: workspace.id,
  };
  const sendAction = sendMessageAction.bind(null, actionCtx);
  const boundResolveApproval = resolveApprovalAction.bind(null, actionCtx);
  const boundResolvePlan = resolvePlanAction.bind(null, actionCtx);
  const boundCancelTask = cancelBackgroundTaskAction.bind(null, actionCtx);
  const boundReadTask = readBackgroundTaskAction.bind(null, {
    orgId: tenant.id,
    workspaceId: workspace.id,
  });

  // Agent-surface capabilities feed the plan-card amend UX. Computed
  // once per render here so the client doesn't refetch / refilter.
  const agentCapabilities: AgentCapability[] = listCapabilities()
    .filter((c) => getSurfaces(c).includes("agent"))
    .map((c) => ({
      name: c.name,
      description: c.description,
      riskLevel: c.agent?.riskLevel ?? "low",
    }));

  return (
    <div className="mx-auto h-full max-w-4xl">
      <ChatShell
        conversationId={conversationId}
        activeLeafMessageId={activeLeafMessageId}
        messagesPromise={messagesPromise}
        sendAction={sendAction}
        resolveApprovalAction={boundResolveApproval}
        resolvePlanAction={boundResolvePlan}
        fetchBackgroundTask={boundReadTask}
        cancelBackgroundTask={boundCancelTask}
        agentCapabilities={agentCapabilities}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
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
    contentBlocks: Array.isArray(r.contentBlocks) ? r.contentBlocks : undefined,
  }));
}
