import { notFound } from "next/navigation";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { PageHeader } from "@/components/ui/page-header";
import { workspace } from "@/lib/routes";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import { getAgent } from "@/lib/workbench/agents";
import { loadEquipSources } from "@/lib/workbench/equip-sources";
import {
  listAgentRoleOptions,
  fallbackSystemRoleOptions,
  getAssignedAgentRole,
  getAgentRolePreview,
  type AgentRoleOption,
} from "@/lib/workbench/agent-roles";
import { AgentBuilder } from "../agent-builder";
import {
  installPlugin,
  installBulkPlugin,
} from "@/lib/agent-tools/install-actions";
import { AgentEnvironmentsCard } from "./agent-environments-card";
import {
  readAgentBindingsAction,
  readEnvironmentOptionsAction,
  readTemplateOptionsAction,
  bindAgentEnvironmentAction,
  unbindAgentEnvironmentAction,
  type AgentEnvironmentBinding,
  type EnvironmentOption,
  type TemplateOption,
} from "./environments-actions";

interface PageProps {
  params: Promise<{
    orgSlug: string;
    workspaceSlug: string;
    agentId: string;
  }>;
}

/**
 * Workbench → Agents → [agentId]. Loads the agent definition and the four Equip
 * pools, then renders the Agent Builder in "edit" mode. A `managed` (built-in)
 * agent is read-only: the builder still renders for inspection but every
 * mutation is disabled. A non-manager also gets a read-only view.
 */
export default async function EditAgentPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug, agentId } = await params;

  const { ctx, org, ws, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );

  let agent;
  try {
    agent = await getAgent(ctx, agentId);
  } catch {
    notFound();
  }

  // Timeout-guarded so a slow/hanging equip source never blocks the builder.
  const sources = await loadEquipSources(ctx, org.id, ws.id);

  const readOnly = agent.managed || !canManage;

  // Role picker data (Agent RBAC Phase 5a). Fail-soft, same posture as the
  // create page: system-role fallback + a visible error when the load fails.
  let roleOptions: AgentRoleOption[];
  let customRolesAvailable = false;
  let rolesError: string | null = null;
  let initialRoleName: string | null = null;
  try {
    const roleData = await listAgentRoleOptions(ctx);
    roleOptions = roleData.options;
    customRolesAvailable = roleData.customRolesAvailable;
  } catch (err) {
    roleOptions = fallbackSystemRoleOptions();
    rolesError = err instanceof Error ? err.message : "Unknown error";
  }
  try {
    initialRoleName = await getAssignedAgentRole(ctx, agent.publicId);
  } catch {
    // A pre-RBAC agent (no principal) or a transient failure: no badge — the
    // picker still defaults to "Agent Contributor" for the next save.
    initialRoleName = null;
  }
  // Reviewer preview: get_agent_role returns the assigned role's grant list
  // authoritatively (even when unassigned) — use it to refresh that option's
  // grants so the review step reflects the live role, fail-soft.
  if (initialRoleName !== null) {
    try {
      const preview = await getAgentRolePreview(
        ctx,
        agent.publicId,
        initialRoleName,
      );
      roleOptions = roleOptions.map((option) =>
        option.roleName === preview.roleName
          ? { ...option, grants: preview.grants, grantsKnown: true }
          : option,
      );
    } catch {
      // keep the list_iam_roles grants already on the option.
    }
  }

  // Environment bindings + the options that populate the bind form. Each read
  // degrades to empty so a failure never blocks the builder from rendering.
  const scope = { orgSlug, workspaceSlug };
  const [bindings, environments, templates] = await Promise.all([
    readAgentBindingsAction({ ...scope, agentId: agent.publicId }).then(
      (d) => d,
      () => [] as AgentEnvironmentBinding[],
    ),
    readEnvironmentOptionsAction(scope).then(
      (d) => d,
      () => [] as EnvironmentOption[],
    ),
    readTemplateOptionsAction(scope).then(
      (d) => d,
      () => [] as TemplateOption[],
    ),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={agent.name}
        description={
          readOnly
            ? "Read-only agent view."
            : "Edit this agent's identity, instructions, and equipment."
        }
        className="pb-0"
        breadcrumb={
          <Breadcrumb
            items={[
              {
                label: "Agents",
                href: workspace.workbench.agents({ orgSlug, workspaceSlug }),
              },
              { label: agent.name },
            ]}
          />
        }
      />
      <AgentBuilder
        mode="edit"
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        canManage={canManage}
        readOnly={readOnly}
        initialAgent={{
          publicId: agent.publicId,
          slug: agent.slug,
          agentKey: agent.agentKey,
          name: agent.name,
          description: agent.description,
          avatarUrl: agent.avatarUrl,
          agentType: agent.agentType,
          status: agent.status,
          deploymentStatus: agent.deploymentStatus,
          version: agent.version,
          isPublished: agent.isPublished,
          config: agent.config,
        }}
        sources={{
          ...sources,
          // A subagent may not load itself; exclude the current agent from the pool.
          subagents: sources.subagents.filter((a) => a.ref !== agent.publicId),
        }}
        installAction={installPlugin}
        installBulkAction={installBulkPlugin}
        roleOptions={roleOptions}
        customRolesAvailable={customRolesAvailable}
        rolesError={rolesError}
        initialRoleName={initialRoleName}
      />
      <AgentEnvironmentsCard
        scope={scope}
        agentId={agent.publicId}
        canManage={canManage && !agent.managed}
        bindings={bindings}
        environments={environments}
        templates={templates}
        bindAction={bindAgentEnvironmentAction}
        unbindAction={unbindAgentEnvironmentAction}
      />
    </div>
  );
}
