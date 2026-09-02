/**
 * page.tsx — Workspace → Settings → Agent Defaults.
 *
 * One page with four in-page sub-tabs (Models · Budget · Prompts · Memory
 * Policy), controlled by `?tab=`. See ./agent-defaults-tabs.tsx.
 *
 * All sub-tab reads run in parallel (one Promise.all): the shared
 * owner/admin role lookup + get_model_settings + get_budget_policy +
 * get_prompt_settings + get_workspace_user_preferences share ONE
 * runInTenantScope; the self-contained readers (readMemoryPolicyAction,
 * loadCodeModeOptions, loadAgentOptions — each already wraps its own
 * scope/never throws) run alongside. Each sub-tab keeps its own independent
 * save + feedback — there is no cross-tab save.
 *
 * The Models sub-tab additionally surfaces the "Your coding-agent
 * preferences" section (CodingAgentPreferencesForm), which writes the calling
 * user's own `user.workspace_preferences`.
 */
import type { Metadata } from "next";
import { Cpu, Wallet } from "lucide-react";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind every foundation handler so invoke() can resolve.
import "@oxagen/handlers/register";
import { resolvePrompt, chatSystemPrompt } from "@oxagen/ai";
import type { WorkspaceModelSettingsReadOutput } from "@oxagen/oxagen/contracts/workspace.model_settings.read";
import type { WorkspaceBudgetPolicyReadOutput } from "@oxagen/oxagen/contracts/workspace.budget_policy.read";
import type { UserWorkspacePreferencesReadOutput } from "@oxagen/oxagen/contracts/user.workspace_preferences.read";
import type { ModelDefaultsValue } from "@/components/settings/model-defaults-fields";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { getEnterpriseAccess } from "@/lib/enterprise";
import { loadCodeModeOptions } from "@/app/[orgSlug]/[workspaceSlug]/_shared/code-mode-data";
import { loadAgentOptions } from "@/app/[orgSlug]/[workspaceSlug]/_shared/agent-options-data";
import { WorkspaceModelsForm } from "./models-form";
import { WorkspaceBudgetForm } from "./budget-form";
import { PromptSettingsForm } from "./prompt-settings-form";
import { SystemPromptReadonly } from "./system-prompt-readonly";
import type { PromptSettingsReadOutput } from "./prompt-settings-action";
import { MemoryPolicyForm } from "./memory-policy-form";
import { readMemoryPolicyAction } from "./memory-policy-actions";
import { CodingAgentPreferencesForm } from "./coding-agent-preferences-form";
import { AgentDefaultsTabs } from "./agent-defaults-tabs";
// Guard + type come from the boundary-agnostic sibling — importing them from
// the "use client" tabs module would make isAgentDefaultsTab() a client
// reference that throws when this Server Component calls it during render.
import {
  isAgentDefaultsTab,
  type AgentDefaultsTab,
} from "./agent-defaults-tabs-shared";

export const metadata: Metadata = {
  title: "Agent Defaults — Workspace Settings",
};

const EDITOR_ROLES = new Set(["owner", "admin"]);

export default async function AgentDefaultsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const sp = await searchParams;
  const initialTab: AgentDefaultsTab = isAgentDefaultsTab(sp.tab)
    ? sp.tab
    : "models";

  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  const ctx = {
    orgId: org.id,
    workspaceId: ws.id,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  const [
    { roleRows, modelSettings, budgetPolicy, promptSettings, codingPrefs },
    enterpriseAccess,
    memoryPolicy,
    codeModeOptions,
    agentOptions,
  ] = await Promise.all([
    runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
      const [
        roleRows,
        modelSettings,
        budgetPolicy,
        promptSettings,
        codingPrefs,
      ] = await Promise.all([
        withTenantDb((tx) =>
          tx
            .select({ role: schema.workspaceUsers.role })
            .from(schema.workspaceUsers)
            .where(
              and(
                eq(schema.workspaceUsers.workspaceId, ws.id),
                eq(schema.workspaceUsers.userId, session.user.id),
              ),
            )
            .limit(1),
        ),
        invoke("get_model_settings", {}, ctx, {
          surface: "agent",
        }) as Promise<WorkspaceModelSettingsReadOutput>,
        invoke("get_budget_policy", {}, ctx, {
          surface: "agent",
        }) as Promise<WorkspaceBudgetPolicyReadOutput>,
        invoke("get_prompt_settings", {}, ctx, {
          surface: "agent",
        }) as Promise<PromptSettingsReadOutput>,
        invoke("get_workspace_user_preferences", {}, ctx, {
          surface: "agent",
        }) as Promise<UserWorkspacePreferencesReadOutput>,
      ]);
      return {
        roleRows,
        modelSettings,
        budgetPolicy,
        promptSettings,
        codingPrefs,
      };
    }),
    getEnterpriseAccess(org.id),
    readMemoryPolicyAction({ orgSlug, workspaceSlug }),
    loadCodeModeOptions(org.id, ws.id, ctx),
    loadAgentOptions(org.id, ws.id, ctx),
  ]);

  const role = (roleRows[0]?.role ?? "").toLowerCase();
  const canEdit = EDITOR_ROLES.has(role);

  const modelDefaultsInitial: ModelDefaultsValue = {
    textTier: modelSettings.defaultTextTier,
    textModel: modelSettings.defaultTextModel,
    imageModel: modelSettings.defaultImageModel,
    videoModel: modelSettings.defaultVideoModel,
  };

  // Effective system prompt: pure function of workspace context + the saved
  // Additional instructions — what admins see here is what the agent runs.
  const effectiveSystemPrompt = resolvePrompt({
    key: "chat.system",
    baseline: chatSystemPrompt({
      orgSlug,
      workspaceSlug,
      orgName: org.name,
      workspaceName: ws.name,
    }),
    config: { additionalInstructions: promptSettings.additionalInstructions },
  });

  return (
    <AgentDefaultsTabs
      initialTab={initialTab}
      modelsPanel={
        <div className="flex flex-col gap-8">
          <div className="flex flex-col gap-5 max-w-2xl">
            <div className="flex items-start gap-3">
              <Cpu
                className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-semibold text-foreground">
                  AI model defaults
                </p>
                <p className="text-xs text-muted-foreground">
                  The default text tier and image/video models applied to every
                  agent run and Workbench generation in this workspace.
                  Workspace defaults take precedence over personal preferences
                  for all members.
                </p>
              </div>
            </div>

            <WorkspaceModelsForm
              initial={modelDefaultsInitial}
              canEdit={canEdit}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
            />
          </div>

          <CodingAgentPreferencesForm
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            repos={codeModeOptions.repos}
            environments={codeModeOptions.environments}
            agents={agentOptions}
            initialRepoConnectionId={codingPrefs.defaultRepoConnectionId}
            initialRepoSlug={codingPrefs.defaultRepoSlug}
            initialEnvironmentId={codingPrefs.defaultEnvironmentId}
            initialAgentId={codingPrefs.defaultAgentId}
          />
        </div>
      }
      budgetPanel={
        <div className="flex flex-col gap-5 max-w-2xl">
          <div className="flex items-start gap-3">
            <Wallet
              className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div>
              <p className="text-sm font-semibold text-foreground">
                Workspace turn budget
              </p>
              <p className="text-xs text-muted-foreground">
                Govern the per-turn dollar budget every member in this workspace
                runs under. A <strong>hard ceiling</strong> clamps every
                member&apos;s effective budget — they cannot exceed it and the
                enforcement mode can only get stricter. A{" "}
                <strong>default</strong> only seeds a member who hasn&apos;t set
                their own budget; they can still raise or lower it.
              </p>
            </div>
          </div>

          <WorkspaceBudgetForm
            initial={budgetPolicy}
            canEdit={canEdit}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
          />
        </div>
      }
      promptsPanel={
        <div className="flex flex-col gap-8 max-w-2xl">
          <SystemPromptReadonly prompt={effectiveSystemPrompt} />
          <PromptSettingsForm
            initial={promptSettings}
            canEdit={canEdit}
            isEnterprise={enterpriseAccess.isEnterprise}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
          />
        </div>
      }
      memoryPanel={
        <MemoryPolicyForm
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialHalfLifeLow={memoryPolicy.halfLifeLowDays}
          initialHalfLifeHigh={memoryPolicy.halfLifeHighDays}
          initialRecallThreshold={memoryPolicy.recallThreshold}
          initialComplianceThreshold={memoryPolicy.complianceThreshold}
          initialDefaultDecayFloor={memoryPolicy.defaultDecayFloor}
        />
      }
    />
  );
}
