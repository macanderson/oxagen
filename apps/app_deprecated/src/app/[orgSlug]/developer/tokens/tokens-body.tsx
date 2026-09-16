import { desc, eq } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import { logger } from "@oxagen/handlers/logger";
import { resolveOrg } from "@/lib/resolve-org";
import { TokensPanel } from "./tokens-panel";

// WHY withSystemDb AND NOT withTenantDb: `auth.api_keys` is policy class
// `standard` (packages/database/src/tenant-policy.manifest.ts), so its RLS
// USING clause requires workspace_id to equal the workspace GUC. This is an
// organization-level page with no workspace, and under the org-only workspace
// sentinel that predicate matched nothing: a key minted with a real workspace
// — which is every key the CLI mints, see
// apps/api/src/routes/v1/auth.cli.token.ts — was invisible here. This is also
// the revoke and rotate surface, so a key nobody could see was a key nobody
// could revoke, and the bare `catch { return [] }` rendered that as "no keys"
// rather than as the failure it was. Tenant isolation is enforced here
// explicitly instead, by the eq(orgId) fence below, and a genuine read failure
// is now logged rather than swallowed silently.
export async function DeveloperTokensBody({ orgSlug }: { orgSlug: string }) {
  const tenant = await resolveOrg(orgSlug);

  const keys = await (async () => {
    try {
      return await withSystemDb((tx) =>
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
      );
    } catch (err) {
      logger.error(
        { err, orgId: tenant.id },
        "developer/tokens: API key list failed; rendering an empty panel",
      );
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
