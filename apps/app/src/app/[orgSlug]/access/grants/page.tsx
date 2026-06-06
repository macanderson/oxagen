import { desc, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { resolveOrg } from "@/lib/resolve-org";

// Sentinel workspaceId for org-only routes (no workspace context). — OXA-1515
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";
import { ShieldCheck, Shield, XCircle, AlertTriangle } from "lucide-react";
import { Card, CardPanel, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const EFFECT_LABEL: Record<string, string> = {
  allow: "Allow",
  deny: "Deny",
  require_approval: "Require approval",
};

export default async function AccessGrantsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const tenant = await resolveOrg(orgSlug);

  // Org-only route — sentinel workspaceId. — OXA-1515
  const grants = await (async () => {
    try {
      return await runInTenantScope(
        { orgId: tenant.id, workspaceId: ORG_ONLY_WS },
        () =>
          withTenantDb((tx) =>
            tx
              .select({
                publicId: schema.grants.publicId,
                capabilityId: schema.grants.capabilityId,
                effect: schema.grants.effect,
                scopeKind: schema.grants.scopeKind,
                grantedAt: schema.grants.grantedAt,
                expiresAt: schema.grants.expiresAt,
                principalId: schema.grants.principalId,
              })
              .from(schema.grants)
              .where(eq(schema.grants.orgId, tenant.id))
              .orderBy(desc(schema.grants.grantedAt))
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
              <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <div>
              <CardTitle>Capability grants</CardTitle>
              <CardDescription>
                Direct principal-to-capability grants outside of roles.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardPanel>
          {grants.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No explicit grants. Capabilities are typically granted via roles.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {grants.map((g) => (
                <div
                  key={g.publicId}
                  className="flex flex-col gap-1.5 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                    <p className="font-mono text-xs font-medium text-foreground truncate">
                      {g.capabilityId}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Scope: {g.scopeKind} · Granted {formatDate(g.grantedAt)}
                      {g.expiresAt ? ` · Expires ${formatDate(g.expiresAt)}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge
                      variant={
                        g.effect === "allow"
                          ? "default"
                          : g.effect === "deny"
                          ? "destructive"
                          : "muted"
                      }
                      className="text-xs"
                    >
                      {g.effect === "allow" ? (
                        <Shield className="mr-1 h-3 w-3" aria-hidden="true" />
                      ) : g.effect === "deny" ? (
                        <XCircle className="mr-1 h-3 w-3" aria-hidden="true" />
                      ) : (
                        <AlertTriangle className="mr-1 h-3 w-3" aria-hidden="true" />
                      )}
                      {EFFECT_LABEL[g.effect] ?? g.effect}
                    </Badge>
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
