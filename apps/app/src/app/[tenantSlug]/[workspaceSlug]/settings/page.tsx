import { eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { resolveTenant, resolveWorkspace } from "@/lib/resolve-tenant";
import { MemberList } from "@/components/workspace/member-list";

export default async function WorkspaceSettingsPage({
  params,
}: {
  params: Promise<{ tenantSlug: string; workspaceSlug: string }>;
}) {
  const { tenantSlug, workspaceSlug } = await params;
  const tenant = await resolveTenant(tenantSlug);
  const workspace = await resolveWorkspace(tenant.id, workspaceSlug);

  const rows = await db()
    .select({
      publicId: schema.workspaceUsers.publicId,
      role: schema.workspaceUsers.role,
      joinedAt: schema.workspaceUsers.joinedAt,
      email: schema.users.email,
      displayName: schema.users.displayName,
    })
    .from(schema.workspaceUsers)
    .innerJoin(schema.users, eq(schema.users.id, schema.workspaceUsers.userId))
    .where(eq(schema.workspaceUsers.workspaceId, workspace.id));

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">{workspace.name} settings</h1>
        <p className="text-sm text-muted-foreground">Workspace-level access and configuration.</p>
      </header>
      <MemberList
        title="Workspace members"
        members={rows.map((r) => ({
          publicId: r.publicId,
          email: r.email,
          displayName: r.displayName,
          role: r.role,
          joinedAt: r.joinedAt,
        }))}
      />
    </div>
  );
}
