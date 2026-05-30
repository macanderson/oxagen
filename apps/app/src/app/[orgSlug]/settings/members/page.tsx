import { eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { resolveOrg } from "@/lib/resolve-org";
import { MemberList } from "@/components/workspace/member-list";

export default async function MembersPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const tenant = await resolveOrg(orgSlug);

  const rows = await db()
    .select({
      publicId: schema.orgUsers.publicId,
      role: schema.orgUsers.role,
      joinedAt: schema.orgUsers.joinedAt,
      email: schema.users.email,
      displayName: schema.users.displayName,
    })
    .from(schema.orgUsers)
    .innerJoin(schema.users, eq(schema.users.id, schema.orgUsers.userId))
    .where(eq(schema.orgUsers.orgId, tenant.id));

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Members</h1>
        <p className="text-sm text-muted-foreground">Manage who has access to {tenant.name}.</p>
      </header>
      <MemberList
        title="Tenant members"
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
