import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
// tenancy: unscoped seam (resolves the active org/workspace from slugs/session
// before a tenant scope exists — this is the canonical bootstrap step that
// PRODUCES the orgId/workspaceId used by runInTenantScope in callers;
// withSystemDb bypasses RLS deliberately; tables read: org.organizations,
// workspace.workspaces, org.org_users) — OXA-1515

export interface ResolvedOrg {
  id: string;
  publicId: string;
  name: string;
  slug: string;
}

export interface ResolvedWorkspace {
  id: string;
  publicId: string;
  orgId: string;
  name: string;
  slug: string;
}

// Per-request memoization keeps slug → row resolution at one query per
// boundary, even when several RSCs in the same render need the tenant.
export const resolveOrg = cache(async (slug: string): Promise<ResolvedOrg> => {
  const rows = await withSystemDb((tx) =>
    tx
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug))
      .limit(1),
  );
  const row = rows[0];
  if (!row) notFound();
  return {
    id: row.id,
    publicId: row.publicId,
    name: row.name,
    slug: row.slug,
  };
});

export const resolveWorkspace = cache(
  async (orgId: string, slug: string): Promise<ResolvedWorkspace> => {
    const rows = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.workspaces)
        .where(and(eq(schema.workspaces.orgId, orgId), eq(schema.workspaces.slug, slug)))
        .limit(1),
    );
    const row = rows[0];
    if (!row) notFound();
    return {
      id: row.id,
      publicId: row.publicId,
      orgId: row.orgId,
      name: row.name,
      slug: row.slug,
    };
  },
);

/**
 * Assert that the given user is a member of the given org.
 *
 * Queries the org_users table for an (orgId, userId) row. If the user is
 * not a member, calls `notFound()` (HTTP 404, rendered by not-found.tsx).
 * 404 (rather than 403) is deliberate: a non-member should not even be able
 * to confirm the org exists — it is indistinguishable from an unknown slug,
 * which resolveOrg() also answers with notFound(). (`forbidden()`/403 would
 * require Next's experimental `authInterrupts` flag, which this app does not
 * enable.)
 *
 * Use AFTER resolveOrg() in any server-side path where an authenticated user
 * reads org-scoped data. Without this gate, any authenticated user can read
 * any org's data by guessing the slug (IDOR vulnerability).
 *
 * Per-request memoized: multiple calls with the same (orgId, userId) pair
 * within a single React render tree incur only one DB query.
 */
export const assertOrgMember = cache(
  async (orgId: string, userId: string): Promise<void> => {
    const rows = await withSystemDb((tx) =>
      tx
        .select({ id: schema.orgUsers.id })
        .from(schema.orgUsers)
        .where(
          and(
            eq(schema.orgUsers.orgId, orgId),
            eq(schema.orgUsers.userId, userId),
          ),
        )
        .limit(1),
    );
    if (rows.length === 0) {
      notFound();
    }
  },
);

/** Roles permitted to manage plugins (MCP servers, integrations, content tools). */
const MCP_MANAGER_ROLES = new Set(["owner", "admin"]);

/**
 * Assert that the user is a member of the org AND holds a plugin-management
 * role (owner/admin). Calls `notFound()` otherwise — consistent with
 * {@link assertBillingManager}. Use in any server route/action that mutates
 * org plugin governance (install, uninstall, denylist, registry, enable/disable).
 */
export const assertMcpManager = cache(
  async (orgId: string, userId: string): Promise<void> => {
    const rows = await withSystemDb((tx) =>
      tx
        .select({ role: schema.orgUsers.role })
        .from(schema.orgUsers)
        .where(
          and(
            eq(schema.orgUsers.orgId, orgId),
            eq(schema.orgUsers.userId, userId),
          ),
        )
        .limit(1),
    );
    const role = rows[0]?.role;
    if (!role || !MCP_MANAGER_ROLES.has(role)) {
      notFound();
    }
  },
);

/** Roles permitted to manage billing (mirror of the billing actions gate). */
const BILLING_MANAGER_ROLES = new Set(["owner", "admin", "billing"]);

/**
 * Assert that the user is a member of the org AND holds a billing-management
 * role (owner/admin/billing). Calls `notFound()` otherwise — a non-manager is
 * treated like a non-member (404), consistent with {@link assertOrgMember}.
 *
 * Use in any server route/action that MUTATES billing or starts a paid Stripe
 * flow (checkout, credit purchase). Membership alone is NOT sufficient: without
 * the role gate any org member could spend the org's money or change its plan.
 */
export const assertBillingManager = cache(
  async (orgId: string, userId: string): Promise<void> => {
    const rows = await withSystemDb((tx) =>
      tx
        .select({ role: schema.orgUsers.role })
        .from(schema.orgUsers)
        .where(
          and(
            eq(schema.orgUsers.orgId, orgId),
            eq(schema.orgUsers.userId, userId),
          ),
        )
        .limit(1),
    );
    const role = rows[0]?.role;
    if (!role || !BILLING_MANAGER_ROLES.has(role)) {
      notFound();
    }
  },
);
