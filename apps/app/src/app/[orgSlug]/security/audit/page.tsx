import { desc, eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { resolveOrg } from "@/lib/resolve-org";
import { ScrollText, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { Card, CardPanel, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

function formatDate(d: Date): string {
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const OUTCOME_VARIANT: Record<string, "default" | "destructive" | "muted" | "outline"> = {
  allow: "default",
  success: "default",
  deny: "destructive",
  error: "muted",
};

export default async function SecurityAuditPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const tenant = await resolveOrg(orgSlug);

  const events = await (async () => {
    try {
      return await db()
        .select({
          id: schema.securityEvents.id,
          eventType: schema.securityEvents.eventType,
          outcome: schema.securityEvents.outcome,
          capability: schema.securityEvents.capability,
          actorUserId: schema.securityEvents.actorUserId,
          ip: schema.securityEvents.ip,
          occurredAt: schema.securityEvents.occurredAt,
        })
        .from(schema.securityEvents)
        .where(eq(schema.securityEvents.orgId, tenant.id))
        .orderBy(desc(schema.securityEvents.occurredAt))
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
              <ScrollText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <div>
              <CardTitle>Audit log</CardTitle>
              <CardDescription>
                Append-only security event stream. The most recent 50 events are shown.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardPanel>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No security events recorded yet.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {events.map((e) => (
                <div
                  key={e.id}
                  className="flex flex-col gap-1.5 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                    <p className="font-mono text-xs font-medium text-foreground truncate">
                      {e.eventType}
                      {e.capability ? ` · ${e.capability}` : ""}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>{formatDate(e.occurredAt)}</span>
                      {e.ip && <span>{e.ip}</span>}
                    </div>
                  </div>
                  <Badge
                    variant={OUTCOME_VARIANT[e.outcome] ?? "outline"}
                    className="shrink-0 text-xs"
                  >
                    {e.outcome === "allow" || e.outcome === "success" ? (
                      <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden="true" />
                    ) : e.outcome === "deny" ? (
                      <XCircle className="mr-1 h-3 w-3" aria-hidden="true" />
                    ) : (
                      <AlertTriangle className="mr-1 h-3 w-3" aria-hidden="true" />
                    )}
                    {e.outcome}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardPanel>
      </Card>
    </div>
  );
}
