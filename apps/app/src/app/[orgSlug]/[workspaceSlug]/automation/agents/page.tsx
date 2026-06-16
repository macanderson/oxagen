/**
 * page.tsx — Workspace → Agents (list).
 *
 * Reads workspace agents via `agent.definition.list` and per-agent trigger
 * counts via `agent.trigger.list`, then renders the agents list. Mirrors the
 * workspace settings page structure (auth → resolve org/workspace → invoke).
 */
import type { Metadata } from "next";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { AgentsList } from "./agents-list";
import type { AgentDefinitionListOutput, AgentTriggerListOutput } from "./agent-actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Agents — Workspace",
};

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function AgentsPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
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

  const { agents, canEdit } = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    async () => {
      const list = (await invoke(
        "agent.definition.list",
        {},
        ctx,
        { surface: "agent" },
      )) as AgentDefinitionListOutput;

      // Trigger counts per agent (sequential — list is small and this avoids a
      // burst of concurrent tenant-scoped sessions).
      const withCounts = [];
      for (const agent of list.agents) {
        const triggerList = (await invoke(
          "agent.trigger.list",
          { agentId: agent.agentId },
          ctx,
          { surface: "agent" },
        )) as AgentTriggerListOutput;
        withCounts.push({ ...agent, triggerCount: triggerList.triggers.length });
      }

      const wsRoleRows = await withTenantDb((tx) =>
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
      );
      const wsRole = wsRoleRows[0]?.role ?? "";

      return {
        agents: withCounts,
        canEdit: ["owner", "admin"].includes(wsRole.toLowerCase()),
      };
    },
  );

  return (
    <AgentsList
      agents={agents}
      canEdit={canEdit}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
    />
  );
}
