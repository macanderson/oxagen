import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";
import { WorkspaceGeneralForm } from "./workspace-general-form";

export default async function SettingsGeneralPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  return (
    <WorkspaceGeneralForm
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      workspaceId={ws.id}
      initialName={ws.name}
      initialSlug={ws.slug}
      initialDescription={ws.description}
    />
  );
}
