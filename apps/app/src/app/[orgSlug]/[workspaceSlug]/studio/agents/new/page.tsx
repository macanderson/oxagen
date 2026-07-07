import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { resolveStudioScope } from "@/lib/studio/scope";
import { listAgents } from "@/lib/studio/agents";
import { listAgentTools } from "@/lib/studio/tools";
import {
  listWorkspaceSkills,
  listInstalledMcpServers,
} from "@/lib/studio/equip-sources";
import { AgentBuilder } from "../agent-builder";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

/**
 * Studio → Agents → New. Gathers the four Equip pools (skills / tools /
 * subagents / MCP servers) and renders the Agent Builder in "create" mode.
 * Non-managers are bounced back to the list — building is Owner/Admin-only.
 */
export default async function NewAgentPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };

  const { ctx, org, ws, canManage } = await resolveStudioScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) redirect(workspace.studio.agents(routeCtx));

  const [skills, tools, subagents, mcp] = await Promise.all([
    listWorkspaceSkills(ctx),
    listAgentTools(ctx),
    listAgents(ctx),
    listInstalledMcpServers(ctx, org.id, ws.id),
  ]);

  return (
    <AgentBuilder
      mode="create"
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      canManage={canManage}
      readOnly={false}
      sources={{
        skills,
        tools,
        subagents: subagents.map((a) => ({
          ref: a.publicId,
          name: a.name,
          slug: a.slug,
        })),
        mcp,
      }}
    />
  );
}
