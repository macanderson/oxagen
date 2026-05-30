import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const tenant = await resolveOrg(orgSlug);
  await resolveWorkspace(tenant.id, workspaceSlug);
  return <>{children}</>;
}
