import { Panel } from "@/components/ui/panel";
import { NewWorkspaceForm } from "@/components/workspace/new-workspace-form";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";
import { createWorkspaceAction } from "./actions";

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
      <Panel title="Create a workspace" className="w-full max-w-3xl">
        <p className="mb-4 text-sm text-muted-foreground">
          Workspaces scope the knowledge graph, data, and agents inside{" "}
          {org.name}. You&rsquo;ll be the workspace owner.
        </p>
        <NewWorkspaceForm orgSlug={orgSlug} action={action} />
      </Panel>
    </div>
  );
}
