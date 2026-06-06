import { desc, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { resolveOrg } from "@/lib/resolve-org";

// Sentinel workspaceId for org-only routes (no workspace context). — OXA-1515
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";
import { Users, Lock } from "lucide-react";
import { Card, CardPanel, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default async function AccessRolesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const tenant = await resolveOrg(orgSlug);

  // Org-only route — sentinel workspaceId. — OXA-1515
  const roles = await (async () => {
    try {
      return await runInTenantScope(
        { orgId: tenant.id, workspaceId: ORG_ONLY_WS },
        () =>
          withTenantDb((tx) =>
            tx
              .select({
                publicId: schema.roles.publicId,
                name: schema.roles.name,
                description: schema.roles.description,
                scopeKind: schema.roles.scopeKind,
                isSystemDefault: schema.roles.isSystemDefault,
                version: schema.roles.version,
                createdAt: schema.roles.createdAt,
              })
              .from(schema.roles)
              .where(eq(schema.roles.orgId, tenant.id))
              .orderBy(desc(schema.roles.createdAt))
              .limit(50),
          ),
      );
    } catch {
      return [];
    }
  })();

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
              <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <div>
              <CardTitle>Role builder</CardTitle>
              <CardDescription>
                System and custom roles for this organization.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardPanel>
          {roles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No roles found. System default roles are seeded on org creation.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {roles.map((r) => (
                <div
                  key={r.publicId}
                  className="flex flex-col gap-1.5 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-foreground truncate">{r.name}</p>
                      {r.isSystemDefault && (
                        <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="System role" />
                      )}
                    </div>
                    {r.description && (
                      <p className="text-xs text-muted-foreground truncate">{r.description}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-xs capitalize">{r.scopeKind}</Badge>
                    <Badge variant={r.isSystemDefault ? "muted" : "outline"} className="text-xs">
                      v{r.version}
                    </Badge>
                    {r.isSystemDefault && (
                      <Badge variant="muted" className="text-xs">System</Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardPanel>
      </Card>
    </div>
  );
}
