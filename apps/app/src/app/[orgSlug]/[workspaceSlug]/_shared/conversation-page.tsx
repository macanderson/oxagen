import { eq, and, desc, isNull } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import type { ConversationRow, DbMessageRow } from "@oxagen/database";
import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { ChatShell, type ChatMessage } from "@/components/chat/chat-shell";
import type { AgentCapability } from "@/components/chat/plan-card";
import { listCapabilities, getSurfaces } from "@oxagen/oxagen";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { BackgroundTaskSnapshot } from "@/components/chat/background-task-tray";
import type { PlanStep } from "@/components/chat/stream-event-types";
import { loadEffectiveModelDefaults } from "@oxagen/ai";
import { buildSeededModelState } from "@/components/chat/model-state";
import type { McpServerSummary } from "@/components/chat/mcp-types";
import { userPreferencesReadHandler } from "@oxagen/handlers/user.preferences.read";
import { conversationListHandler } from "@oxagen/handlers/conversation.list";
import { ConversationNav } from "@/components/conversations/conversation-nav";
import type { ConversationNavActions } from "@/components/conversations/types";
import {
  listConversationsAction,
  renameConversationAction,
  archiveConversationsAction,
  deleteConversationsAction,
  purgeArchivedConversationsAction,
} from "./conversation-actions";
import { walkActiveBranch } from "./walk-active-branch";
export { walkActiveBranch } from "./walk-active-branch";

// The unbound action factories — one set per route module because each
// module hard-codes its own revalidatePath segment (/chat vs /ask).
// ConversationPage resolves org/workspace once and calls .bind() itself,
// so the DB round-trip is not duplicated across the wrapper + this module.
export interface ConversationPageActions {
  sendMessageAction: (
    ctx: { orgSlug: string; workspaceSlug: string; orgId: string; workspaceId: string },
    formData: FormData,
  ) => Promise<
    | { ok: true; conversationId: string; conversationPublicId: string; userMessageId: string }
    | { ok: false; error: string }
  >;
  resolveApprovalAction: (
    ctx: { orgSlug: string; workspaceSlug: string; orgId: string; workspaceId: string },
    approvalId: string,
    decision: "approved" | "denied",
  ) => Promise<{ ok: boolean; error?: string }>;
  resolveConsentAction: (
    ctx: { orgSlug: string; workspaceSlug: string; orgId: string; workspaceId: string },
    approvalId: string,
    decision: "granted" | "denied",
    grantAllTools: boolean,
  ) => Promise<{ ok: boolean; error?: string }>;
  resolvePlanAction: (
    ctx: { orgSlug: string; workspaceSlug: string; orgId: string; workspaceId: string },
    planId: string,
    decision: "approved" | "denied" | "amended",
    amendedSteps?: PlanStep[],
  ) => Promise<{ ok: boolean; error?: string }>;
  cancelBackgroundTaskAction: (
    ctx: { orgSlug: string; workspaceSlug: string; orgId: string; workspaceId: string },
    taskId: string,
    reason?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  readBackgroundTaskAction: (
    ctx: { orgId: string; workspaceId: string },
    taskId: string,
  ) => Promise<BackgroundTaskSnapshot>;
}

interface ConversationPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{ c?: string; new?: string }>;
  actions: ConversationPageActions;
}


export async function ConversationPage({ params, searchParams, actions }: ConversationPageProps) {
  const session = await getSessionOrRedirect();
  const [{ orgSlug, workspaceSlug }, { c: conversationPublicId, new: forceNew }] = await Promise.all([
    params,
    searchParams,
  ]);
  const tenant = await resolveOrg(orgSlug);
  const workspace = await resolveWorkspace(tenant.id, workspaceSlug);

  let conversationId: string | null = null;
  let activeLeafMessageId: string | null = null;

  // `?c=<publicId>` selects a specific conversation. `?new=1` forces a blank
  // slate (used by the "New conversation" button). Without either, auto-resume
  // the most recent active conversation so users land in context on page load.
  // A blank slate is only shown when no active conversations exist.
  // Workspace-scoped read — real orgId + workspaceId. — OXA-1515
  const conv: ConversationRow | undefined = forceNew === "1"
    ? undefined
    : await runInTenantScope(
        { orgId: tenant.id, workspaceId: workspace.id },
        () =>
          withTenantDb((tx) =>
            tx
              .select()
              .from(schema.conversations)
              .where(
                conversationPublicId
                  ? and(
                      eq(schema.conversations.publicId, conversationPublicId),
                      eq(schema.conversations.orgId, tenant.id),
                      eq(schema.conversations.workspaceId, workspace.id),
                    )
                  : and(
                      eq(schema.conversations.orgId, tenant.id),
                      eq(schema.conversations.workspaceId, workspace.id),
                      isNull(schema.conversations.archivedAt),
                      isNull(schema.conversations.deletedAt),
                    ),
              )
              .orderBy(desc(schema.conversations.updatedAt))
              .limit(1),
          ),
      ).then((rows) => rows[0]).catch((err: unknown) => {
        // Non-fatal: degrade to a blank new-conversation state rather than
        // crashing the page. Log so operators can detect RLS misconfigurations
        // or DB failures without silent production blind spots.
        console.error("[conversation-page] conversation lookup failed", err);
        return undefined;
      });

  if (conv) {
    conversationId = conv.id;
    activeLeafMessageId = conv.activeLeafMessageId ?? null;
  }

  const actionCtx = {
    orgSlug,
    workspaceSlug,
    orgId: tenant.id,
    workspaceId: workspace.id,
  };

  // Promise lifts the message query into the RSC stream — the composer
  // renders eagerly while the active-branch walk resolves.
  // Workspace-scoped read — real orgId + workspaceId. — OXA-1515
  const messagesPromise = (async (): Promise<ChatMessage[]> => {
    if (!conversationId) return [];
    const rows: DbMessageRow[] = await runInTenantScope(
      { orgId: tenant.id, workspaceId: workspace.id },
      () =>
        withTenantDb((tx) =>
          tx
            .select()
            .from(schema.messages)
            .where(eq(schema.messages.conversationId, conversationId))
            .orderBy(desc(schema.messages.createdAt))
            .limit(200),
        ),
    );
    return walkActiveBranch(rows, activeLeafMessageId);
  })();

  const sendAction = actions.sendMessageAction.bind(null, actionCtx);
  const boundResolveApproval = actions.resolveApprovalAction.bind(null, actionCtx);
  const boundResolveConsent = actions.resolveConsentAction.bind(null, actionCtx);
  const boundResolvePlan = actions.resolvePlanAction.bind(null, actionCtx);
  const boundCancelTask = actions.cancelBackgroundTaskAction.bind(null, actionCtx);
  const boundReadTask = actions.readBackgroundTaskAction.bind(null, {
    orgId: tenant.id,
    workspaceId: workspace.id,
  });

  // User preferences + effective model defaults — fetched in parallel with
  // the capability list. Failures are non-fatal: fall back to defaults so
  // the chat page never crashes due to a missing prefs row.
  const userCtx: CapabilityContext = {
    orgId: tenant.id,
    workspaceId: workspace.id,
    userId: session.user.id,
    apiKeyId: null,
    requestId: crypto.randomUUID(),
    surface: "app",
    messageId: null,
  };

  // Agent-surface capabilities feed the plan-card amend UX. Computed
  // once per render here so the client doesn't refetch / refilter.
  const [agentCapabilities, userPrefs, effectiveModelDefaults, initialConversations, availableMcpServers] =
    await Promise.all([
      Promise.resolve(
        listCapabilities()
          .filter((c) => getSurfaces(c).includes("agent"))
          .map((c) => ({
            name: c.name,
            description: c.description,
            riskLevel: c.agent?.riskLevel ?? "low",
          })),
      ),
      userPreferencesReadHandler({}, userCtx).catch(() => ({
        enterToSubmit: false as const,
        pendingPromptBehavior: "queue" as const,
      })),
      loadEffectiveModelDefaults({
        userId: session.user.id,
        workspaceId: workspace.id,
      }).catch(() => null),
      // First page of active conversations for the history nav. Failure is
      // non-fatal — the nav renders empty rather than crashing the chat page.
      // runInTenantScope is required: conversationListHandler calls withTenantDb
      // which requires an active ALS scope; without it every call throws and the
      // list is silently empty.
      runInTenantScope(
        { orgId: tenant.id, workspaceId: workspace.id },
        () => conversationListHandler({ filter: "active", limit: 50, cursor: null }, userCtx),
      ).catch(() => ({ conversations: [], nextCursor: null })),
      // Enabled + healthy workspace MCP servers for the per-turn activation picker.
      runInTenantScope(
        { orgId: tenant.id, workspaceId: workspace.id },
        () =>
          withTenantDb((tx) =>
            tx
              .select({
                publicId: schema.mcpServers.publicId,
                name: schema.mcpServers.name,
                healthStatus: schema.mcpServers.healthStatus,
                discoveredTools: schema.mcpServers.discoveredTools,
              })
              .from(schema.mcpServers)
              .innerJoin(
                schema.pluginInstalledPlugins,
                eq(schema.mcpServers.orgListingId, schema.pluginInstalledPlugins.id),
              )
              .where(
                and(
                  eq(schema.mcpServers.orgId, tenant.id),
                  eq(schema.mcpServers.workspaceId, workspace.id),
                  eq(schema.mcpServers.enabled, true),
                  eq(schema.mcpServers.healthStatus, "healthy"),
                  eq(schema.pluginInstalledPlugins.enabled, true),
                  isNull(schema.pluginInstalledPlugins.deletedAt),
                ),
              ),
          ),
      )
        .then((rows) =>
          rows.map((r): McpServerSummary => ({
            publicId: r.publicId,
            name: r.name,
            healthStatus: r.healthStatus as McpServerSummary["healthStatus"],
            toolCount: Array.isArray(r.discoveredTools) ? (r.discoveredTools as unknown[]).length : 0,
          })),
        )
        .catch(() => [] as McpServerSummary[]),
    ]);

  // Bind the workspace scope into the nav's server actions so the client only
  // hands them user input, never org/workspace ids.
  const navCtx = { orgSlug, workspaceSlug };
  const conversationNavActions: ConversationNavActions = {
    list: listConversationsAction.bind(null, navCtx),
    rename: renameConversationAction.bind(null, navCtx),
    archive: archiveConversationsAction.bind(null, navCtx),
    delete: deleteConversationsAction.bind(null, navCtx),
    purge: purgeArchivedConversationsAction.bind(null, navCtx),
  };

  const initialModelState = effectiveModelDefaults
    ? buildSeededModelState({
        textModel: effectiveModelDefaults.text.model,
        textTier: effectiveModelDefaults.text.tier,
        imageModel: effectiveModelDefaults.image.model,
        videoModel: effectiveModelDefaults.video.model,
      })
    : undefined;

  return (
    <div className="flex h-full flex-col gap-3 md:flex-row md:gap-4">
      <ConversationNav
        currentPublicId={conv?.publicId ?? null}
        initialActive={initialConversations.conversations}
        initialActiveNextCursor={initialConversations.nextCursor}
        actions={conversationNavActions}
      />
      <div className="min-h-0 min-w-0 flex-1">
        <div className="mx-auto h-full max-w-4xl">
          <ChatShell
            conversationId={conversationId}
            conversationPublicId={conv?.publicId ?? null}
            activeLeafMessageId={activeLeafMessageId}
            messagesPromise={messagesPromise}
            sendAction={sendAction}
            resolveApprovalAction={boundResolveApproval}
            resolveConsentAction={boundResolveConsent}
            resolvePlanAction={boundResolvePlan}
            fetchBackgroundTask={boundReadTask}
            cancelBackgroundTask={boundCancelTask}
            agentCapabilities={agentCapabilities as AgentCapability[]}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            enterToSubmit={userPrefs.enterToSubmit}
            pendingPromptBehavior={userPrefs.pendingPromptBehavior}
            initialModelState={initialModelState}
            availableMcpServers={availableMcpServers}
          />
        </div>
      </div>
    </div>
  );
}
