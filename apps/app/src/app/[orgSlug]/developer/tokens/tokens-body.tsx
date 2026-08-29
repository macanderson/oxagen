import { desc, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { resolveOrg } from "@/lib/resolve-org";
import { TokensPanel } from "./tokens-panel";

// Sentinel workspaceId for org-only routes (no workspace context).
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

export async function DeveloperTokensBody({ orgSlug }: { orgSlug: string }) {
  const tenant = await resolveOrg(orgSlug);

  const keys = await (async () => {
    try {
      return await runInTenantScope(
        { orgId: tenant.id, workspaceId: ORG_ONLY_WS },
        () =>
          withTenantDb((tx) =>
            tx
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
              .limit(50),
          ),
      );
    } catch {
      return [];
    }
  })();

  // Serialize dates for the client component
  const serializedKeys = keys.map((k) => ({
    ...k,
    expiresAt: k.expiresAt?.toISOString() ?? null,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
    deletedAt: k.deletedAt?.toISOString() ?? null,
  }));

  return <TokensPanel orgSlug={orgSlug} keys={serializedKeys} />;
}
