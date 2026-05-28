import { resolveTenant, resolveWorkspace } from "@/lib/resolve-tenant";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tenantSlug: string; workspaceSlug: string }>;
}) {
  const { tenantSlug, workspaceSlug } = await params;
  const tenant = await resolveTenant(tenantSlug);
  await resolveWorkspace(tenant.id, workspaceSlug);
  return <>{children}</>;
}
