import "server-only";
import { cache } from "react";
import { notFound, forbidden } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";

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
  const rows = await db()
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, slug))
    .limit(1);
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
    const rows = await db()
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.orgId, orgId), eq(schema.workspaces.slug, slug)))
      .limit(1);
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
 * not a member, calls `forbidden()` which throws a Next.js 403 response —
 * identical semantics to `notFound()` for 404s.
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
    const rows = await db()
      .select({ id: schema.orgUsers.id })
      .from(schema.orgUsers)
      .where(
        and(
          eq(schema.orgUsers.orgId, orgId),
          eq(schema.orgUsers.userId, userId),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      forbidden();
    }
  },
);
