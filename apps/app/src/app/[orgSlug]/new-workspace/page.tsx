import { Card, CardPanel, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NewWorkspaceForm } from "@/components/workspace/new-workspace-form";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";
import { createWorkspaceAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function NewWorkspacePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const session = await getSessionOrRedirect();
  const { orgSlug } = await params;
  const org = await resolveOrg(orgSlug);
  await assertOrgMember(org.id, session.user.id);

  // Bind the org slug so the client form only deals with FormData.
  const action = createWorkspaceAction.bind(null, orgSlug);

  return (
    <div className="mx-auto max-w-lg py-8">
      <Card>
        <CardHeader>
          <CardTitle>Create a workspace</CardTitle>
          <CardDescription>
            Workspaces scope the knowledge graph, data, and agents inside {org.name}. You&rsquo;ll
            be the workspace owner.
          </CardDescription>
        </CardHeader>
        <CardPanel>
          <NewWorkspaceForm orgSlug={orgSlug} action={action} />
        </CardPanel>
      </Card>
    </div>
  );
}
