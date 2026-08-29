import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { PageHeader } from "@/components/ui/page-header";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { requestScopeSlugs } from "@/lib/request-path";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import { loadEquipSources } from "@/lib/workbench/equip-sources";
import {
  listAgentRoleOptions,
  fallbackSystemRoleOptions,
  type AgentRoleOption,
} from "@/lib/workbench/agent-roles";
import { AgentBuilder } from "../agent-builder";
import {
  installPlugin,
  installBulkPlugin,
} from "@/lib/agent-tools/install-actions";

export const metadata: Metadata = {
  title: "New Agent | Workbench",
};

/**
 * Workbench → Agents → New. Gathers the four Equip pools (skills / tools /
 * subagents / MCP servers) and renders the Agent Builder in "create" mode.
 * Non-managers are bounced back to the list — building is Owner/Admin-only.
 *
 * Slugs come from the request URL (requestScopeSlugs), NOT `params`: the
 * non-manager `redirect()` below regresses to a client meta-refresh and 500s
 * the shell if `params` is awaited first under Cache Components. See
 * lib/request-path.ts.
 */
export default async function NewAgentPage() {
  const { orgSlug, workspaceSlug } = await requestScopeSlugs();
  if (!orgSlug || !workspaceSlug) notFound();
  const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };

  const { ctx, org, ws, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) redirect(workspace.workbench.agents(routeCtx));

  // Timeout-guarded so a slow/hanging equip source never blocks the builder.
  const sources = await loadEquipSources(ctx, org.id, ws.id);

  // Role picker data (Agent RBAC Phase 5a). Fail-soft: a load failure falls
  // back to the built-in system role definitions (grant counts unavailable
  // and flagged as such) so the builder never renders without an Access step.
  let roleOptions: AgentRoleOption[];
  let customRolesAvailable = false;
  let rolesError: string | null = null;
  try {
    const roleData = await listAgentRoleOptions(ctx);
    roleOptions = roleData.options;
    customRolesAvailable = roleData.customRolesAvailable;
  } catch (err) {
    roleOptions = fallbackSystemRoleOptions();
    rolesError = err instanceof Error ? err.message : "Unknown error";
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="New agent"
        description="Compose an agent step by step — identity, instructions, and everything it's equipped with."
        className="pb-0"
        breadcrumb={
          <Breadcrumb
            items={[
              { label: "Agents", href: workspace.workbench.agents(routeCtx) },
              { label: "New" },
            ]}
          />
        }
      />
      <AgentBuilder
        mode="create"
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        canManage={canManage}
        readOnly={false}
        sources={sources}
        installAction={installPlugin}
        installBulkAction={installBulkPlugin}
        roleOptions={roleOptions}
        customRolesAvailable={customRolesAvailable}
        rolesError={rolesError}
        initialRoleName={null}
      />
    </div>
  );
}
