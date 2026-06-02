import { desc, eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { resolveOrg } from "@/lib/resolve-org";
import { Clock, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const STATUS_VARIANT: Record<string, "default" | "destructive" | "muted" | "outline"> = {
  pending: "muted",
  approved: "default",
  denied: "destructive",
  expired: "outline",
};

export default async function AccessRequestsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const tenant = await resolveOrg(orgSlug);

  const requests = await (async () => {
    try {
      return await db()
        .select({
          publicId: schema.accessRequests.publicId,
          capabilityId: schema.accessRequests.capabilityId,
          scopeKind: schema.accessRequests.scopeKind,
          status: schema.accessRequests.status,
          justification: schema.accessRequests.justification,
          approvedAt: schema.accessRequests.approvedAt,
          ttlSeconds: schema.accessRequests.ttlSeconds,
          createdAt: schema.accessRequests.createdAt,
        })
        .from(schema.accessRequests)
        .where(eq(schema.accessRequests.orgId, tenant.id))
        .orderBy(desc(schema.accessRequests.createdAt))
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
              <Clock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <div>
              <CardTitle>JIT access requests</CardTitle>
              <CardDescription>
                Just-in-time access requests and approval history.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No access requests yet. JIT requests appear here when principals request temporary capability access.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {requests.map((r) => (
                <div
                  key={r.publicId}
                  className="flex flex-col gap-1.5 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                    <p className="font-mono text-xs font-medium text-foreground truncate">
                      {r.capabilityId}
                    </p>
                    {r.justification && (
                      <p className="text-xs text-muted-foreground truncate italic">
                        &ldquo;{r.justification}&rdquo;
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Requested {formatDate(r.createdAt)} · Scope: {r.scopeKind}
                      {r.ttlSeconds ? ` · TTL: ${Math.round(r.ttlSeconds / 3600)}h` : ""}
                    </p>
                  </div>
                  <Badge
                    variant={STATUS_VARIANT[r.status] ?? "outline"}
                    className="shrink-0 text-xs capitalize"
                  >
                    {r.status === "approved" ? (
                      <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden="true" />
                    ) : r.status === "denied" ? (
                      <XCircle className="mr-1 h-3 w-3" aria-hidden="true" />
                    ) : r.status === "expired" ? (
                      <AlertTriangle className="mr-1 h-3 w-3" aria-hidden="true" />
                    ) : (
                      <Clock className="mr-1 h-3 w-3" aria-hidden="true" />
                    )}
                    {r.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
