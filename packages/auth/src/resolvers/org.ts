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

export type OrgScopeResolutionError =
  | { kind: "not_found" }
  | { kind: "not_member" };

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
 *   a typed error kind (not_found | not_member) on failure.
 */
export async function resolveOrgScope(
  userId: string,
  slug: string,
): Promise<OrgScopeResolution> {
  // tenancy: system bypass via withSystemDb (identity resolution before a tenant scope exists) — OXA-1515
  // Resolves an org slug → orgId and verifies membership. This function IS the
  // resolution step: it runs before any tenant scope can be established, and its
  // output (orgId) is required to construct one. Both queries (organizations +
  // orgUsers) are global identity tables that carry no per-tenant RLS.
  const org = await withSystemDb((tx) =>
    tx.query.organizations.findFirst({
      where: eq(schema.organizations.slug, slug),
      columns: { id: true },
    }),
  );

  if (!org) return { ok: false, kind: "not_found" };

  const membership = await withSystemDb((tx) =>
    tx.query.orgUsers.findFirst({
      where: and(eq(schema.orgUsers.orgId, org.id), eq(schema.orgUsers.userId, userId)),
      columns: { id: true },
    }),
  );

  if (!membership) return { ok: false, kind: "not_member" };

  return { ok: true, orgId: org.id };
}
