import { desc, eq } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import { logger } from "@oxagen/handlers/logger";
import { assertOrgAdmin, resolveOrg } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
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
//
// WHICH PLANE (ADR-042, and ADR-074's Decision 2 requires this to be stated):
// shared. ADR-042 §2 names `auth` among the platform tables that always live on
// the shared plane, so the data-plane resolution and assertDataPlaneUsable that
// withTenantDb was performing guarded a binding this table does not follow. See
// apps/app_deprecated/src/lib/audit-query.ts for why re-adding that assertion
// per caller would gate a shared-plane read on a tenant's Postgres binding
// rather than restore a kill switch.
export async function DeveloperTokensBody({ orgSlug }: { orgSlug: string }) {
  const session = await getSessionOrRedirect();
  const tenant = await resolveOrg(orgSlug);

  // Owner/Admin, not membership. The three actions on this panel already gate
  // here (api-key.ts, buildApiKeyCtx → assertOrgAdmin) because api.key.* is
  // sensitivity:"high" with defaultRoles.org = { Owner, Admin }. The LISTING
  // did not, and was kept narrow by Postgres instead: auth.api_keys is
  // `standard`, so under the org-only workspace sentinel RLS answered it
  // nothing at all. Reading the org's keys correctly without this gate would
  // show every member every workspace's key names, prefixes, scopes and
  // last-used timestamps — the same data list_api_keys classifies as
  // Owner/Admin. The governed capability is the specification; a read and the
  // writes beside it answer to the same role.
  await assertOrgAdmin(tenant.id, session.user.id);

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
