/**
 * resolveOrgScope — transport-agnostic org scope resolution.
 *
 * Resolves an org slug to an orgId and verifies that the given userId is a
 * member of that org. Returns null when the org does not exist or the user is
 * not a member, preventing cross-tenant access.
 *
 * This function has no HTTP dependency — it can be called identically from
 * API middleware, MCP handler, CLI, or tests.
 */
import { and, eq } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";

export interface OrgScopeResult {
  orgId: string;
}

export type OrgScopeResolutionError = { kind: "not_found" };

export type OrgScopeResolution =
  | ({ ok: true } & OrgScopeResult)
  | ({ ok: false } & OrgScopeResolutionError);

/**
 * Resolves an org slug + userId to an orgId, enforcing membership.
 *
 * @param userId - The authenticated user's ID. Must be non-null; callers
 *   should never reach this function for API-key-authenticated requests that
 *   already carry a pre-bound orgId.
 * @param slug - The org slug from the request path (case-insensitive via
 *   citext column).
 * @returns OrgScopeResolution — ok:true with orgId on success, ok:false with
 *   kind: "not_found" on failure (missing org or non-member both return not_found).
 */
export async function resolveOrgScope(
  userId: string,
  slug: string,
): Promise<OrgScopeResolution> {
  // tenancy: system bypass via withSystemDb (identity resolution before a tenant scope exists)
  // Resolves an org slug → orgId and verifies membership in a single round-trip.
  // Both tables (organizations + orgUsers) are global identity tables that carry
  // no per-tenant RLS. The inner join means a missing org or non-member both
  // return zero rows — we can't distinguish them here, so we return not_found
  // for either case (membership is enforced; the exact reason is not surfaced to
  // callers to avoid org-existence enumeration).
  const rows = await withSystemDb((tx) =>
    tx
      .select({ orgId: schema.organizations.id })
      .from(schema.organizations)
      .innerJoin(
        schema.orgUsers,
        and(
          eq(schema.orgUsers.orgId, schema.organizations.id),
          eq(schema.orgUsers.userId, userId),
        ),
      )
      .where(eq(schema.organizations.slug, slug))
      .limit(1),
  );

  if (rows.length === 0) return { ok: false, kind: "not_found" };

  return { ok: true, orgId: rows[0]!.orgId };
}
