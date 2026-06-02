import { eq, and, desc } from "drizzle-orm";
import { db, schema } from "@oxagen/database";
import type { ConversationRow, DbMessageRow } from "@oxagen/database";
import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { ChatShell, type ChatMessage } from "@/components/chat/chat-shell";
import type { AgentCapability } from "@/components/chat/plan-card";
import type { AssistantContentBlock } from "@/components/chat/stream-event-types";
import { listCapabilities, getSurfaces } from "@oxagen/oxagen";
import {
  cancelBackgroundTaskAction,
  readBackgroundTaskAction,
  resolveApprovalAction,
  resolvePlanAction,
  sendMessageAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function AskPage({
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

  let conversationId: string | null = null;
  let activeLeafMessageId: string | null = null;

  const conv: ConversationRow | undefined = conversationPublicId
    ? (
        await db()
          .select()
          .from(schema.conversations)
          .where(
            and(
              eq(schema.conversations.publicId, conversationPublicId),
              eq(schema.conversations.orgId, tenant.id),
              eq(schema.conversations.workspaceId, workspace.id),
            ),
          )
          .limit(1)
      )[0]
    : (
        await db()
          .select()
          .from(schema.conversations)
          .where(
            and(
              eq(schema.conversations.userId, session.user.id),
              eq(schema.conversations.workspaceId, workspace.id),
            ),
          )
          .orderBy(desc(schema.conversations.createdAt))
          .limit(1)
      )[0];

  if (conv) {
    conversationId = conv.id;
    activeLeafMessageId = conv.activeLeafMessageId ?? null;
  }

  // Promise lifts the message query into the RSC stream — the composer
  // renders eagerly while the active-branch walk resolves.
  const messagesPromise = (async (): Promise<ChatMessage[]> => {
    if (!conversationId) return [];
    const rows: DbMessageRow[] = await db()
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(desc(schema.messages.createdAt))
      .limit(200);
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
function walkActiveBranch(rows: DbMessageRow[], leafId: string | null): ChatMessage[] {
  if (rows.length === 0) return [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const childCount = new Map<string, number>();
  for (const r of rows) {
    if (r.parentMessageId) childCount.set(r.parentMessageId, (childCount.get(r.parentMessageId) ?? 0) + 1);
  }
  const path: DbMessageRow[] = [];
  let cursor: DbMessageRow | undefined = leafId
    ? byId.get(leafId)
    : rows.find((r) => r.parentMessageId === null);
  while (cursor) {
    path.unshift(cursor);
    cursor = cursor.parentMessageId ? byId.get(cursor.parentMessageId) : undefined;
  }
  return path.map((r) => ({
    publicId: r.publicId,
    role: r.role as "user" | "assistant" | "system" | "tool",
    content: r.content,
    branchReason: r.branchReason,
    siblingCount: r.parentMessageId ? (childCount.get(r.parentMessageId) ?? 1) : 1,
    contentBlocks: Array.isArray(r.contentBlocks) ? (r.contentBlocks as AssistantContentBlock[]) : undefined,
  }));
}
