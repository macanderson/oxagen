/**
 * [agentSlug]/edit/page.tsx — Workspace → Agents → edit.
 *
 * Reads the current definition (agent.definition.get) and renders the
 * AgentEditorForm in edit mode. Saving produces a NEW unpublished version via
 * agent.definition.update. 404s when the slug does not resolve or the caller
 * cannot edit.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { AgentEditorForm } from "../../agent-editor-form";
import type { AgentDefinitionGetOutput } from "../../agent-actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ agentSlug: string }>;
}): Promise<Metadata> {
  const { agentSlug } = await params;
  return { title: `Edit ${agentSlug} — Agents` };
}

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string; agentSlug: string }>;
}

export default async function EditAgentPage({ params }: PageProps) {
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
        canEdit: ["owner", "admin"].includes(wsRole.toLowerCase()),
      };
    },
  );

  if (!result) notFound();
  if (!result.canEdit) notFound();

  return (
    <div className="max-w-2xl">
      <AgentEditorForm
        mode="edit"
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        ontologyId={result.agent.config.graph.ontologyId}
        agentId={result.agent.agentId}
        agentSlug={result.agent.slug}
        initialName={result.agent.name}
        initialDescription={result.agent.description ?? ""}
        initialConfig={result.agent.config}
        canEdit={result.canEdit}
      />
    </div>
  );
}
