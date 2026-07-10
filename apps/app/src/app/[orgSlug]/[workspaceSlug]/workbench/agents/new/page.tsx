import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import { loadEquipSources } from "@/lib/workbench/equip-sources";
import { AgentBuilder } from "../agent-builder";
import { installPlugin, installBulkPlugin } from "@/lib/agent-tools/install-actions";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

/**
 * Workbench → Agents → New. Gathers the four Equip pools (skills / tools /
 * subagents / MCP servers) and renders the Agent Builder in "create" mode.
 * Non-managers are bounced back to the list — building is Owner/Admin-only.
 */
export default async function NewAgentPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };

  const { ctx, org, ws, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) redirect(workspace.workbench.agents(routeCtx));

  // Timeout-guarded so a slow/hanging equip source never blocks the builder.
  const sources = await loadEquipSources(ctx, org.id, ws.id);

  return (
    <AgentBuilder
      mode="create"
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      canManage={canManage}
      readOnly={false}
      sources={sources}
      installAction={installPlugin}
      installBulkAction={installBulkPlugin}
    />
  );
}
