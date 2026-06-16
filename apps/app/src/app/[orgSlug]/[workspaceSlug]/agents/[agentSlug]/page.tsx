/**
 * [agentSlug]/page.tsx — Workspace → Agents → detail.
 *
 * Reads the agent definition (agent.definition.get accepts a slug) and its
 * triggers (agent.trigger.list), then renders the detail view: config summary,
 * version + deployment state, deploy toggle, publish action, and trigger
 * management. 404s when the slug does not resolve in this workspace.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { AgentDetail } from "./agent-detail";
import type { AgentDefinitionGetOutput, AgentTriggerListOutput } from "../agent-actions";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string; agentSlug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { agentSlug } = await params;
  return { title: `${agentSlug} — Agents` };
}

export default async function AgentDetailPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug, agentSlug } = await params;
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

  const result = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    async () => {
      let agent: AgentDefinitionGetOutput;
      try {
        agent = (await invoke(
          "agent.definition.get",
          { agentId: agentSlug },
          ctx,
          { surface: "agent" },
        )) as AgentDefinitionGetOutput;
      } catch {
        return null;
      }

      const triggerList = (await invoke(
        "agent.trigger.list",
        { agentId: agent.agentId },
        ctx,
        { surface: "agent" },
      )) as AgentTriggerListOutput;

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
        agent,
        triggers: triggerList.triggers,
        canEdit: ["owner", "admin"].includes(wsRole.toLowerCase()),
      };
    },
  );

  if (!result) notFound();

  return (
    <AgentDetail
      agent={result.agent}
      triggers={result.triggers}
      canEdit={result.canEdit}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      agentSlug={agentSlug}
    />
  );
}
