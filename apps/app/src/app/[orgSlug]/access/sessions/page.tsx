import { desc, eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { resolveOrg } from "@/lib/resolve-org";
import { MonitorDot, Globe, CircleSlash } from "lucide-react";
import { Card, CardPanel, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default async function AccessSessionsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const tenant = await resolveOrg(orgSlug);

  const sessions = await (async () => {
    try {
      return await db()
        .select({
          publicId: schema.iamSessions.publicId,
          principalId: schema.iamSessions.principalId,
          startedAt: schema.iamSessions.startedAt,
          expiresAt: schema.iamSessions.expiresAt,
          ip: schema.iamSessions.ip,
          userAgent: schema.iamSessions.userAgent,
          revokedAt: schema.iamSessions.revokedAt,
          revokeReason: schema.iamSessions.revokeReason,
        })
        .from(schema.iamSessions)
        .where(eq(schema.iamSessions.orgId, tenant.id))
        .orderBy(desc(schema.iamSessions.startedAt))
        .limit(50);
    } catch {
      return [];
    }
  })();

  const active = sessions.filter(
    (s) => !s.revokedAt && (!s.expiresAt || s.expiresAt > new Date()),
  );
  const inactive = sessions.filter(
    (s) => s.revokedAt || (s.expiresAt && s.expiresAt <= new Date()),
  );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
              <MonitorDot className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <div>
              <CardTitle>Active sessions</CardTitle>
              <CardDescription>
                All principal sessions in this organization, with revocation status.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardPanel>
          {active.length === 0 && inactive.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No IAM sessions recorded yet.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {active.length > 0 && (
                <>
                  <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground mb-1">
                    Active ({active.length})
                  </p>
                  {active.map((s) => (
                    <div
                      key={s.publicId}
                      className="flex flex-col gap-1.5 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                    >
                      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                        <p className="font-mono text-xs text-muted-foreground truncate">
                          {s.principalId}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          {s.ip && (
                            <span className="flex items-center gap-1">
                              <Globe className="h-3 w-3 shrink-0" aria-hidden="true" />
                              {s.ip}
                            </span>
                          )}
                          <span>Started {formatDate(s.startedAt)}</span>
                          {s.expiresAt && <span>Expires {formatDate(s.expiresAt)}</span>}
                        </div>
                      </div>
                      <Badge variant="default" className="shrink-0 text-xs">Active</Badge>
                    </div>
                  ))}
                </>
              )}

              {inactive.length > 0 && (
                <>
                  <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground mt-4 mb-1">
                    Ended ({inactive.length})
                  </p>
                  {inactive.slice(0, 10).map((s) => (
                    <div
                      key={s.publicId}
                      className="flex flex-col gap-1.5 rounded-xl border border-border/40 bg-muted/10 px-4 py-3 opacity-60 sm:flex-row sm:items-center sm:gap-4"
                    >
                      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                        <p className="font-mono text-xs text-muted-foreground truncate">
                          {s.principalId}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Started {formatDate(s.startedAt)}
                          {s.revokedAt ? ` · Revoked ${formatDate(s.revokedAt)}` : " · Expired"}
                          {s.revokeReason ? ` — ${s.revokeReason}` : ""}
                        </p>
                      </div>
                      <Badge variant="muted" className="shrink-0 text-xs">
                        <CircleSlash className="mr-1 h-3 w-3" aria-hidden="true" />
                        {s.revokedAt ? "Revoked" : "Expired"}
                      </Badge>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </CardPanel>
      </Card>
    </div>
  );
}
