import { desc, eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { resolveOrg } from "@/lib/resolve-org";
import { KeySquare, Clock, Layers } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function obfuscatePrefix(prefix: string): string {
  return `${prefix}${"•".repeat(32)}`;
}

export default async function DeveloperTokensPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const tenant = await resolveOrg(orgSlug);

  const keys = await (async () => {
    try {
      return await db()
        .select({
          publicId: schema.apiKeys.publicId,
          name: schema.apiKeys.name,
          keyPrefix: schema.apiKeys.keyPrefix,
          scope: schema.apiKeys.scope,
          expiresAt: schema.apiKeys.expiresAt,
          lastUsedAt: schema.apiKeys.lastUsedAt,
          createdAt: schema.apiKeys.createdAt,
          deletedAt: schema.apiKeys.deletedAt,
        })
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.orgId, tenant.id))
        .orderBy(desc(schema.apiKeys.createdAt))
        .limit(50);
    } catch {
      return [];
    }
  })();

  const active = keys.filter((k) => !k.deletedAt && (!k.expiresAt || k.expiresAt > new Date()));
  const revoked = keys.filter((k) => k.deletedAt || (k.expiresAt && k.expiresAt <= new Date()));

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
              <KeySquare className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <div>
              <CardTitle>API tokens</CardTitle>
              <CardDescription>
                Scoped service-principal credentials for programmatic access.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {active.length === 0 && revoked.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No API tokens yet. Tokens can be created via the Oxagen API.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {active.length > 0 && (
                <>
                  <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground mb-1">
                    Active
                  </p>
                  {active.map((key) => (
                    <div
                      key={key.publicId}
                      className="flex flex-col gap-1.5 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                    >
                      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{key.name}</p>
                        <p className="font-mono text-xs text-muted-foreground truncate">
                          {obfuscatePrefix(key.keyPrefix)}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          {key.lastUsedAt ? `Last used ${formatDate(key.lastUsedAt)}` : "Never used"}
                        </span>
                        {key.expiresAt ? (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            Expires {formatDate(key.expiresAt)}
                          </span>
                        ) : (
                          <Badge variant="outline" className="text-xs">No expiry</Badge>
                        )}
                        <Badge variant="default" className="text-xs">Active</Badge>
                      </div>
                    </div>
                  ))}
                </>
              )}

              {revoked.length > 0 && (
                <>
                  <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground mt-4 mb-1">
                    Revoked / expired
                  </p>
                  {revoked.map((key) => (
                    <div
                      key={key.publicId}
                      className="flex flex-col gap-1.5 rounded-xl border border-border/40 bg-muted/10 px-4 py-3 opacity-60 sm:flex-row sm:items-center sm:gap-4"
                    >
                      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{key.name}</p>
                        <p className="font-mono text-xs text-muted-foreground truncate">
                          {obfuscatePrefix(key.keyPrefix)}
                        </p>
                      </div>
                      <Badge variant="muted" className="shrink-0 text-xs">
                        {key.deletedAt ? "Revoked" : "Expired"}
                      </Badge>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
