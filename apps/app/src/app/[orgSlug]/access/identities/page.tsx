import { desc, eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { resolveOrg } from "@/lib/resolve-org";
import type { LucideIcon } from "lucide-react";
import { Fingerprint, Bot, User, Cpu } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const KIND_ICON: Record<string, LucideIcon> = {
  human: User,
  agent: Bot,
  service: Cpu,
};

const STATUS_VARIANT: Record<string, "default" | "destructive" | "muted" | "outline"> = {
  active: "default",
  suspended: "muted",
  deleted: "destructive",
};

export default async function AccessIdentitiesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const tenant = await resolveOrg(orgSlug);

  const principals = await (async () => {
    try {
      return await db()
        .select({
          publicId: schema.principals.publicId,
          kind: schema.principals.kind,
          displayName: schema.principals.displayName,
          status: schema.principals.status,
          mfaStatus: schema.principals.mfaStatus,
          idpSubject: schema.principals.idpSubject,
          createdAt: schema.principals.createdAt,
        })
        .from(schema.principals)
        .where(eq(schema.principals.orgId, tenant.id))
        .orderBy(desc(schema.principals.createdAt))
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
              <Fingerprint className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <div>
              <CardTitle>Principal directory</CardTitle>
              <CardDescription>
                Human, agent, and service principal identities in this organization.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {principals.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No principals found. Principals are created when members join or agents are registered.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {principals.map((p) => {
                const KindIcon = KIND_ICON[p.kind] ?? User;
                return (
                  <div
                    key={p.publicId}
                    className="flex flex-col gap-1.5 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <div className="flex flex-1 items-center gap-3 min-w-0">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/40 bg-muted/60">
                        <KindIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      </span>
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{p.displayName}</p>
                        {p.idpSubject && (
                          <p className="font-mono text-xs text-muted-foreground truncate">{p.idpSubject}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Badge variant="outline" className="text-xs capitalize">{p.kind}</Badge>
                      <Badge
                        variant={STATUS_VARIANT[p.status] ?? "outline"}
                        className="text-xs capitalize"
                      >
                        {p.status}
                      </Badge>
                      {p.mfaStatus !== "none" && (
                        <Badge variant="muted" className="text-xs">
                          MFA: {p.mfaStatus}
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
