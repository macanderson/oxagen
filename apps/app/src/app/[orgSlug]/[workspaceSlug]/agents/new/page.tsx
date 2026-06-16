/**
 * new/page.tsx — Workspace → Agents → New.
 *
 * Renders the AgentEditorForm in create mode. Seeds graph access with the
 * workspace id as the ontology binding (per buildInteractiveAgentConfig
 * convention). The created agent is a draft, deployed inactive by default.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { AgentEditorForm } from "../agent-editor-form";
import { defaultAgentConfig } from "../agent-ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "New Agent — Workspace",
};

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function NewAgentPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  const canEdit = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    async () => {
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
      return ["owner", "admin"].includes(wsRole.toLowerCase());
    },
  );

  if (!canEdit) {
    // Non-editors have no create surface — fall through to 404 rather than
    // rendering a disabled form they cannot submit.
    notFound();
  }

  return (
    <div className="max-w-2xl">
      <AgentEditorForm
        mode="create"
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        ontologyId={ws.id}
        initialConfig={defaultAgentConfig(ws.id)}
        canEdit={canEdit}
      />
    </div>
  );
}
