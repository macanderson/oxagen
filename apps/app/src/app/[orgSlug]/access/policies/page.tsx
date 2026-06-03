import { desc, eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { resolveOrg } from "@/lib/resolve-org";
import { FileText, Shield, XCircle, AlertTriangle, Lock } from "lucide-react";
import { Card, CardPanel, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const EFFECT_LABEL: Record<string, string> = {
  allow: "Allow",
  deny: "Deny",
  require_approval: "Require approval",
};

export default async function AccessPoliciesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const tenant = await resolveOrg(orgSlug);

  const policies = await (async () => {
    try {
      return await db()
        .select({
          publicId: schema.policies.publicId,
          name: schema.policies.name,
          capabilityId: schema.policies.capabilityId,
          effect: schema.policies.effect,
          enforced: schema.policies.enforced,
          scopeKind: schema.policies.scopeKind,
          sensitivityTag: schema.policies.sensitivityTag,
          createdAt: schema.policies.createdAt,
        })
        .from(schema.policies)
        .where(eq(schema.policies.orgId, tenant.id))
        .orderBy(desc(schema.policies.createdAt))
        .limit(50);
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
              <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <div>
              <CardTitle>Conditional policies</CardTitle>
              <CardDescription>
                Enforced capability policies with optional conditions and sensitivity tags.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardPanel>
          {policies.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No policies defined. Policies layer conditional constraints on top of role grants.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {policies.map((p) => (
                <div
                  key={p.publicId}
                  className="flex flex-col gap-1.5 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{p.name}</p>
                    <p className="font-mono text-xs text-muted-foreground truncate">
                      {p.capabilityId}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Scope: {p.scopeKind}
                      {p.sensitivityTag ? ` · Tag: ${p.sensitivityTag}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {p.enforced && (
                      <Badge variant="destructive" className="text-xs">
                        <Lock className="mr-1 h-3 w-3" aria-hidden="true" />
                        Enforced
                      </Badge>
                    )}
                    <Badge
                      variant={
                        p.effect === "allow"
                          ? "default"
                          : p.effect === "deny"
                          ? "destructive"
                          : "muted"
                      }
                      className="text-xs"
                    >
                      {p.effect === "allow" ? (
                        <Shield className="mr-1 h-3 w-3" aria-hidden="true" />
                      ) : p.effect === "deny" ? (
                        <XCircle className="mr-1 h-3 w-3" aria-hidden="true" />
                      ) : (
                        <AlertTriangle className="mr-1 h-3 w-3" aria-hidden="true" />
                      )}
                      {EFFECT_LABEL[p.effect] ?? p.effect}
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
