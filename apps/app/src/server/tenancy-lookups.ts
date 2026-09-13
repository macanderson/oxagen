// Tenancy lookups: slug → organization / workspace, membership, and the MFA
// inputs. Ported from apps/app_deprecated/src/lib/resolve-org.ts and the org
// layout's MFA read. These return data and never throw navigation interrupts;
// `resolveViewer` (scope.ts) decides what a miss means.
//
// tenancy: unscoped seam. These run BEFORE a tenant scope exists: they produce
// the orgId/workspaceId that callers then pass to runInTenantScope. withSystemDb
// bypasses RLS deliberately. Tables read: org.organizations, org.org_slug_history,
// org.org_users, workspace.workspaces, workspace.workspace_slug_history,
// workspace.workspace_users, auth.users, security.org_security_policy.
import "server-only";
import { schema, withSystemDb } from "@oxagen/database";
import { and, desc, eq } from "drizzle-orm";
import type { MfaPolicy } from "./mfa-gate";

export type OrgRecord = {
  id: string;
  publicId: string;
  slug: string;
  name: string;
};

export type WorkspaceRecord = {
  id: string;
  publicId: string;
  orgId: string;
  slug: string;
  name: string;
};

export interface TenancyLookups {
  /** The organization whose current slug is `slug`. */
  orgBySlug(slug: string): Promise<OrgRecord | null>;
  /** The organization a redirect-enabled historical slug points at (most recent rename wins). */
  orgBySlugHistory(slug: string): Promise<OrgRecord | null>;
  /** The workspace in `orgId` whose current slug is `slug`. */
  workspaceBySlug(orgId: string, slug: string): Promise<WorkspaceRecord | null>;
  /** The workspace in `orgId` a redirect-enabled historical slug points at. */
  workspaceBySlugHistory(
    orgId: string,
    slug: string,
  ): Promise<WorkspaceRecord | null>;
  /** The member's organization role, lowercased; null for a non-member. */
  orgRole(orgId: string, userId: string): Promise<string | null>;
  isWorkspaceMember(workspaceId: string, userId: string): Promise<boolean>;
  /** The organization's MFA policy, or null when it has none. */
  mfaPolicy(orgId: string): Promise<MfaPolicy | null>;
  twoFactorEnabled(userId: string): Promise<boolean>;
}

function toOrg(row: typeof schema.organizations.$inferSelect): OrgRecord {
  return { id: row.id, publicId: row.publicId, slug: row.slug, name: row.name };
}

function toWorkspace(
  row: typeof schema.workspaces.$inferSelect,
): WorkspaceRecord {
  return {
    id: row.id,
    publicId: row.publicId,
    orgId: row.orgId,
    slug: row.slug,
    name: row.name,
  };
}

async function orgById(orgId: string): Promise<OrgRecord | null> {
  const rows = await withSystemDb((tx) =>
    tx
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId))
      .limit(1),
  );
  return rows[0] ? toOrg(rows[0]) : null;
}

export const liveTenancyLookups: TenancyLookups = {
  async orgBySlug(slug) {
    const rows = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.slug, slug))
        .limit(1),
    );
    return rows[0] ? toOrg(rows[0]) : null;
  },

  async orgBySlugHistory(slug) {
    // ORDER BY changed_at DESC: a recycled slug can appear in several rows; the
    // most recent rename wins. redirect_enabled=false is the admin kill switch.
    const rows = await withSystemDb((tx) =>
      tx
        .select({ orgId: schema.orgSlugHistory.orgId })
        .from(schema.orgSlugHistory)
        .where(
          and(
            eq(schema.orgSlugHistory.oldSlug, slug),
            eq(schema.orgSlugHistory.redirectEnabled, true),
          ),
        )
        .orderBy(desc(schema.orgSlugHistory.changedAt))
        .limit(1),
    );
    const hit = rows[0];
    // The organization may have been deleted after the rename: no canonical URL.
    return hit ? orgById(hit.orgId) : null;
  },

  async workspaceBySlug(orgId, slug) {
    const rows = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.orgId, orgId),
            eq(schema.workspaces.slug, slug),
          ),
        )
        .limit(1),
    );
    return rows[0] ? toWorkspace(rows[0]) : null;
  },

  async workspaceBySlugHistory(orgId, slug) {
    const rows = await withSystemDb((tx) =>
      tx
        .select({ workspaceId: schema.workspaceSlugHistory.workspaceId })
        .from(schema.workspaceSlugHistory)
        .where(
          and(
            eq(schema.workspaceSlugHistory.orgId, orgId),
            eq(schema.workspaceSlugHistory.oldSlug, slug),
            eq(schema.workspaceSlugHistory.redirectEnabled, true),
          ),
        )
        .orderBy(desc(schema.workspaceSlugHistory.changedAt))
        .limit(1),
    );
    const hit = rows[0];
    if (!hit) return null;
    const ws = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.orgId, orgId),
            eq(schema.workspaces.id, hit.workspaceId),
          ),
        )
        .limit(1),
    );
    return ws[0] ? toWorkspace(ws[0]) : null;
  },

  async orgRole(orgId, userId) {
    // org_users.role is written in both casings (lowercase by org.create and
    // invite-accept, TitleCase by the IAM role-change path); lowercase it once here.
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
    return role ? role.toLowerCase() : null;
  },

  async isWorkspaceMember(workspaceId, userId) {
    const rows = await withSystemDb((tx) =>
      tx
        .select({ id: schema.workspaceUsers.id })
        .from(schema.workspaceUsers)
        .where(
          and(
            eq(schema.workspaceUsers.workspaceId, workspaceId),
            eq(schema.workspaceUsers.userId, userId),
          ),
        )
        .limit(1),
    );
    return rows.length > 0;
  },

  async mfaPolicy(orgId) {
    const rows = await withSystemDb((tx) =>
      tx
        .select({
          mfaRequired: schema.orgSecurityPolicy.mfaRequired,
          mfaGraceHours: schema.orgSecurityPolicy.mfaGraceHours,
          updatedAt: schema.orgSecurityPolicy.updatedAt,
        })
        .from(schema.orgSecurityPolicy)
        .where(eq(schema.orgSecurityPolicy.orgId, orgId))
        .limit(1),
    );
    return rows[0] ?? null;
  },

  async twoFactorEnabled(userId) {
    const rows = await withSystemDb((tx) =>
      tx
        .select({ enabled: schema.users.twoFactorEnabled })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1),
    );
    return rows[0]?.enabled ?? false;
  },
};
