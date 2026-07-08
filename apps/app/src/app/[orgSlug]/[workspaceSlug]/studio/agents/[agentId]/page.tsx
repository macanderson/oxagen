import { notFound } from "next/navigation";
import { resolveStudioScope } from "@/lib/studio/scope";
import { getAgent } from "@/lib/studio/agents";
import { loadEquipSources } from "@/lib/studio/equip-sources";
import { AgentBuilder } from "../agent-builder";
import { installPlugin, installBulkPlugin } from "@/lib/agent-tools/install-actions";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{
    orgSlug: string;
    workspaceSlug: string;
    agentId: string;
  }>;
}

/**
 * Studio → Agents → [agentId]. Loads the agent definition and the four Equip
 * pools, then renders the Agent Builder in "edit" mode. A `managed` (built-in)
 * agent is read-only: the builder still renders for inspection but every
 * mutation is disabled. A non-manager also gets a read-only view.
 */
export default async function EditAgentPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug, agentId } = await params;

  const { ctx, org, ws, canManage } = await resolveStudioScope(
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

  return (
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
    />
  );
}
