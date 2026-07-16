import { eq, and, desc, isNull } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import type { ConversationRow, DbMessageRow } from "@oxagen/database";
import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { firstNameOf } from "@/lib/utils";
import { ChatShell, type ChatMessage } from "@/components/chat/chat-shell";
import type { AgentCapability } from "@/components/chat/plan-card";
import { listCapabilities, getSurfaces, invoke } from "@oxagen/oxagen";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { BackgroundTaskSnapshot } from "@/components/chat/background-task-tray";
import type { PlanStep } from "@/components/chat/stream-event-types";
import { loadEffectiveModelDefaults } from "@oxagen/ai";
import { isLowBalance } from "@oxagen/billing";
import { buildSeededModelState } from "@/components/chat/model-state";
import type { WorkspaceBudgetGovernance } from "@/components/chat/model-state";
import type { McpServerSummary } from "@/components/chat/mcp-types";
import { loadCodeModeOptions } from "./code-mode-data";
import { loadAgentOptions } from "./agent-options-data";
import { userPreferencesReadHandler } from "@oxagen/handlers/user.preferences.read";
import { userWorkspacePreferencesReadHandler } from "@oxagen/handlers/user.workspace_preferences.read";
import { budgetPolicyReadHandler } from "@oxagen/handlers/budget.policy.read";
import { conversationListHandler } from "@oxagen/handlers/conversation.list";
import { logger } from "@oxagen/handlers/logger";
// Side-effect import: bind every foundation handler into the shared kernel so
// invoke("get_budget_policy", …) below can resolve its handler.
// Without this the call silently throws "No handler registered" (see CLAUDE.md
// gotcha) — caught below and treated as fail-open null governance regardless.
import "@oxagen/handlers/register";
import { ConversationNav } from "@/components/conversations/conversation-nav";
import type { ConversationNavActions } from "@/components/conversations/types";
import {
  listConversationsAction,
  renameConversationAction,
  archiveConversationsAction,
  deleteConversationsAction,
  purgeArchivedConversationsAction,
} from "./conversation-actions";
import { setDefaultAgentAction } from "./agent-prefs-actions";
import { parseStoredCodeBinding } from "@/app/api/v1/chat/stream/code-binding";
import { walkActiveBranch } from "./walk-active-branch";
export { walkActiveBranch } from "./walk-active-branch";

/**
 * Logs a server-render degrade and returns the fallback unchanged. Keeps the
 * non-blocking control flow (the chat page still renders) while making each
 * failure observable — an RLS/DB error should never silently revert the page to
 * empty/default state with no trace.
 */
function logAndFallback<T>(err: unknown, what: string, fallback: T): T {
  logger.warn({ err }, `conversation-page: ${what} failed — degraded`);
  return fallback;
}

// The unbound action factories — one set per route module because each
// module hard-codes its own revalidatePath segment (/chat vs /ask).
// ConversationPage resolves org/workspace once and calls .bind() itself,
// so the DB round-trip is not duplicated across the wrapper + this module.
export interface ConversationPageActions {
  sendMessageAction: (
    ctx: {
      orgSlug: string;
      workspaceSlug: string;
      orgId: string;
      workspaceId: string;
    },
    formData: FormData,
  ) => Promise<
    | {
        ok: true;
        conversationId: string;
        conversationPublicId: string;
        userMessageId: string;
      }
    | { ok: false; error: string }
  >;
  resolveApprovalAction: (
    ctx: {
      orgSlug: string;
      workspaceSlug: string;
      orgId: string;
      workspaceId: string;
    },
    approvalId: string,
    decision: "approved" | "denied",
  ) => Promise<{ ok: boolean; error?: string }>;
  resolveConsentAction: (
    ctx: {
      orgSlug: string;
      workspaceSlug: string;
      orgId: string;
      workspaceId: string;
    },
    approvalId: string,
    decision: "granted" | "denied",
    grantAllTools: boolean,
  ) => Promise<{ ok: boolean; error?: string }>;
  resolvePlanAction: (
    ctx: {
      orgSlug: string;
      workspaceSlug: string;
      orgId: string;
      workspaceId: string;
    },
    planId: string,
    decision: "approved" | "denied" | "amended",
    amendedSteps?: PlanStep[],
  ) => Promise<{ ok: boolean; error?: string }>;
  cancelBackgroundTaskAction: (
    ctx: {
      orgSlug: string;
      workspaceSlug: string;
      orgId: string;
      workspaceId: string;
    },
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
  searchParams: Promise<{ c?: string; new?: string; agent?: string }>;
  actions: ConversationPageActions;
}

export async function ConversationPage({
  params,
  searchParams,
  actions,
}: ConversationPageProps) {
  const session = await getSessionOrRedirect();
  const [
    { orgSlug, workspaceSlug },
    { c: conversationPublicId, new: forceNew, agent: boundAgentId },
  ] = await Promise.all([params, searchParams]);
  const tenant = await resolveOrg(orgSlug);
  const workspace = await resolveWorkspace(tenant.id, workspaceSlug);

  let conversationId: string | null = null;
  let activeLeafMessageId: string | null = null;

  // `?c=<publicId>` selects a specific conversation. `?new=1` forces a blank
  // slate (used by the "New conversation" button). Without either, auto-resume
  // the most recent active conversation so users land in context on page load.
  // A blank slate is only shown when no active conversations exist.
  // Workspace-scoped read — real orgId + workspaceId. — OXA-1515
  const conv: ConversationRow | undefined =
    forceNew === "1"
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
        )
          .then((rows) => rows[0])
          .catch((err: unknown) => {
            // Non-fatal: degrade to a blank new-conversation state rather than
            // crashing the page. Log so operators can detect RLS misconfigurations
            // or DB failures without silent production blind spots.
            console.error(
              "[conversation-page] conversation lookup failed",
              err,
            );
            return undefined;
          });

  if (conv) {
    conversationId = conv.id;
    activeLeafMessageId = conv.activeLeafMessageId ?? null;
  }

  // Parse the conversation's locked coding target (claimed on its first code
  // turn — see code-binding.ts). Tolerant: a null/corrupt column parses to null
  // (unbound). Threaded to the composer, which forces the agent + repo + env
  // selection to it and renders the pickers read-only for a bound conversation.
  const conversationCodeBinding = conv
    ? parseStoredCodeBinding(conv.codeBinding)
    : null;

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
  const boundResolveApproval = actions.resolveApprovalAction.bind(
    null,
    actionCtx,
  );
  const boundResolveConsent = actions.resolveConsentAction.bind(
    null,
    actionCtx,
  );
  const boundResolvePlan = actions.resolvePlanAction.bind(null, actionCtx);
  const boundCancelTask = actions.cancelBackgroundTaskAction.bind(
    null,
    actionCtx,
  );
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
  const [
    agentCapabilities,
    userPrefs,
    effectiveModelDefaults,
    initialConversations,
    availableMcpServers,
    budgetDefault,
    codeModeOptions,
    workspaceBudgetGovernance,
    availableAgents,
    workspacePrefs,
    walletBalance,
  ] = await Promise.all([
    Promise.resolve(
      listCapabilities()
        .filter((c) => getSurfaces(c).includes("agent"))
        .map((c) => ({
          name: c.name,
          description: c.description,
          riskLevel: c.agent?.riskLevel ?? "low",
        })),
    ),
    userPreferencesReadHandler({}, userCtx).catch((err: unknown) =>
      logAndFallback(err, "user-preferences read", {
        enterToSubmit: false as const,
        pendingPromptBehavior: "queue" as const,
      }),
    ),
    // runInTenantScope is required here too: loadEffectiveModelDefaults reads
    // workspace model settings via withTenantDb; without an active ALS scope
    // it throws TenantScopeError and the defaults silently degrade to null.
    runInTenantScope({ orgId: tenant.id, workspaceId: workspace.id }, () =>
      loadEffectiveModelDefaults({
        userId: session.user.id,
        workspaceId: workspace.id,
      }),
    ).catch((err: unknown) =>
      logAndFallback(err, "effective-model-defaults load", null),
    ),
    // First page of active conversations for the history nav. Failure is
    // non-fatal — the nav renders empty rather than crashing the chat page.
    // runInTenantScope is required: conversationListHandler calls withTenantDb
    // which requires an active ALS scope; without it every call throws and the
    // list is silently empty.
    runInTenantScope({ orgId: tenant.id, workspaceId: workspace.id }, () =>
      conversationListHandler(
        { filter: "active", limit: 50, cursor: null },
        userCtx,
      ),
    ).catch((err: unknown) =>
      logAndFallback(err, "conversation-list read", {
        conversations: [],
        nextCursor: null,
      }),
    ),
    // Enabled + healthy workspace MCP servers for the per-turn activation picker.
    runInTenantScope({ orgId: tenant.id, workspaceId: workspace.id }, () =>
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
            eq(
              schema.mcpServers.orgListingId,
              schema.pluginInstalledPlugins.id,
            ),
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
        rows.map(
          (r): McpServerSummary => ({
            publicId: r.publicId,
            name: r.name,
            healthStatus: r.healthStatus as McpServerSummary["healthStatus"],
            toolCount: Array.isArray(r.discoveredTools)
              ? (r.discoveredTools as unknown[]).length
              : 0,
          }),
        ),
      )
      .catch((err: unknown) =>
        logAndFallback(err, "mcp-servers read", [] as McpServerSummary[]),
      ),
    // Per-turn budget default (OXA — turn-budget): read the user's saved
    // budget.policy so the composer's BudgetControl opens pre-filled with
    // their last-saved preference rather than always defaulting to off.
    // Direct handler call (not invoke()) — same pattern as
    // userPreferencesReadHandler above; budget.policy is user-scoped
    // (scoped: false) so it needs no IAM bootstrap.
    budgetPolicyReadHandler({}, userCtx).catch((err: unknown) =>
      logAndFallback(err, "budget-policy read", {
        enabled: false as const,
        limitUsd: null,
        mode: "prompt" as const,
        graceOveragePct: 0.25,
      }),
    ),
    // Repo + environment options for the composer's code-mode pickers.
    // loadCodeModeOptions never throws (degrades to empty lists internally),
    // so no .catch needed here.
    loadCodeModeOptions(tenant.id, workspace.id, userCtx),
    // Workspace-level budget governance (OXA-2081): resolved via invoke()
    // (Owner/Admin-managed governance state, not a user preference row) so
    // the composer can surface an enforced ceiling / seed a soft default.
    // { surface: "agent" } — the contract's `surfaces` does not include
    // "app". FAIL-OPEN: any error (unregistered handler, down DB, denied
    // check) degrades to `null` (no governance) so a broken governance row
    // never blocks the chat page from rendering.
    runInTenantScope({ orgId: tenant.id, workspaceId: workspace.id }, () =>
      invoke("get_budget_policy", {}, userCtx, { surface: "agent" }),
    )
      .then((raw): WorkspaceBudgetGovernance => {
        const read = raw as {
          enabled: boolean;
          limitUsd: number | null;
          mode: "grace" | "prompt" | "enforce";
          enforcement: "default" | "ceiling";
        };
        return {
          enabled: read.enabled,
          limitUsd: read.limitUsd ?? 0,
          mode: read.mode,
          enforcement: read.enforcement,
        };
      })
      .catch((err: unknown) =>
        logAndFallback(err, "workspace-budget-governance read", {
          enabled: false as const,
          limitUsd: 0,
          mode: "prompt" as const,
          enforcement: "ceiling" as const,
        }),
      ),
    // Selectable agents for the composer's agent picker. loadAgentOptions
    // never throws (degrades to an empty list internally), so no .catch here.
    loadAgentOptions(tenant.id, workspace.id, userCtx),
    // Workspace user's coding defaults (default agent + repo/env) so the
    // agent picker can seed the initial selection and prefill a code agent's
    // repo/environment. runInTenantScope is required — the handler reads via
    // withTenantDb (RLS). Degrades to the no-defaults shape on any failure.
    runInTenantScope({ orgId: tenant.id, workspaceId: workspace.id }, () =>
      userWorkspacePreferencesReadHandler({}, userCtx),
    ).catch((err: unknown) =>
      logAndFallback(err, "workspace-preferences read", {
        defaultRepoConnectionId: null,
        defaultRepoSlug: null,
        defaultEnvironmentId: null,
        defaultAgentId: null,
        repoDefaultPrompted: false,
      }),
    ),
    // Wallet balance for the chat_ux_v2 session drawer's footer row (same
    // loader + scope the shell's balance pill uses: credit_lots is org-only
    // under RLS, so the scope's workspaceId is the all-zeros org-only
    // sentinel). Fail-open null — the drawer just hides the wallet row rather
    // than blocking the chat page.
    runInTenantScope(
      { orgId: tenant.id, workspaceId: "00000000-0000-0000-0000-000000000000" },
      () => isLowBalance(tenant.id),
    ).catch((err: unknown) => logAndFallback(err, "wallet-balance read", null)),
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

  // The ?agent=<publicId> binding seeds the composer's initial agent selection
  // (forwarded as `agentId` below); the picker chip reflects it and the user
  // can switch agents from there. The actual config application happens
  // server-side in the chat stream route.

  const initialModelState = effectiveModelDefaults
    ? buildSeededModelState({
        textModel: effectiveModelDefaults.text.model,
        textTier: effectiveModelDefaults.text.tier,
        imageModel: effectiveModelDefaults.image.model,
        videoModel: effectiveModelDefaults.video.model,
        budget: budgetDefault,
      })
    : undefined;

  return (
    // `relative` anchors ConversationNav's floating mobile trigger (absolute,
    // top-left) so it overlays the transcript instead of taking an in-flow row
    // that shrinks the conversation's height on phones. On mobile the trigger is
    // out of flow and the desktop aside is hidden, so the chat column is the
    // sole in-flow child and gets the full viewport height.
    <div className="relative flex h-full flex-col gap-3 md:flex-row md:gap-4">
      <ConversationNav
        currentPublicId={conv?.publicId ?? null}
        initialActive={initialConversations.conversations}
        initialActiveNextCursor={initialConversations.nextCursor}
        actions={conversationNavActions}
      />
      <div className="min-h-0 min-w-0 flex-1">
        {/* No width cap: the conversation is the page's primary real estate,
          so it claims every pixel the (collapsible) conversation nav leaves
          free — collapsing the nav hands its width to the transcript instead
          of widening dead gutters. The activity rail is a fixed-width flex
          sibling inside ChatShell. */}
        <div className="h-full">
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
            availableRepos={codeModeOptions.repos}
            availableEnvironments={codeModeOptions.environments}
            availableAgents={availableAgents}
            defaultAgentId={workspacePrefs.defaultAgentId}
            defaultRepoConnectionId={workspacePrefs.defaultRepoConnectionId}
            defaultRepoSlug={workspacePrefs.defaultRepoSlug}
            defaultEnvironmentId={workspacePrefs.defaultEnvironmentId}
            setDefaultAgentAction={setDefaultAgentAction.bind(null, navCtx)}
            workspaceBudgetGovernance={workspaceBudgetGovernance}
            agentId={boundAgentId ?? null}
            conversationCodeBinding={conversationCodeBinding}
            walletBalanceCents={walletBalance?.balanceCents ?? null}
            userFirstName={firstNameOf(session.user.name)}
          />
        </div>
      </div>
    </div>
  );
}
