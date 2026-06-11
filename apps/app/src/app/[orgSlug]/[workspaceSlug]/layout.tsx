import { resolveOrg, resolveWorkspace, assertWorkspaceMember } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const session = await getSessionOrRedirect();
  const { orgSlug, workspaceSlug } = await params;
  const tenant = await resolveOrg(orgSlug);
  // Validates the workspace exists and returns notFound() if not.
  const workspace = await resolveWorkspace(tenant.id, workspaceSlug);
  // Tenant isolation: gate every workspace-scoped page on workspace membership.
  // Without this, any org member can read another workspace's data within the
  // same org by guessing the workspace slug (IDOR). Non-members get a 404 via
  // notFound() — consistent with assertOrgMember above. — OXA-1515
  await assertWorkspaceMember(workspace.id, session.user.id);
  return <>{children}</>;
}
