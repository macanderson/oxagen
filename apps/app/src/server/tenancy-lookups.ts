// System lookups (ARCHITECTURE.md §3.7): slug → organization / workspace,
// membership, the MFA inputs, and the invitation behind a public token. Ported
// from apps/app_deprecated/src/lib/resolve-org.ts and the org layout's MFA
// read. These return data and never throw navigation interrupts; `resolveViewer`
// (scope.ts) decides what a miss means.
//
// tenancy: unscoped seam. These run BEFORE a tenant scope exists: they produce
// the orgId/workspaceId that callers then pass to runInTenantScope, or name the
// organization an invitee is not yet a member of. withSystemDb bypasses RLS
// deliberately. Tables read (INV-05): org.organizations, org.org_slug_history,
// org.org_users, org.invitations, workspace.workspaces,
// workspace.workspace_slug_history, workspace.workspace_users, auth.users
// (columns id and two_factor_enabled), security.org_security_policy.
import "server-only";
import { schema, withSystemDb } from "@oxagen/database";
import { and, desc, eq } from "drizzle-orm";
import type { MfaPolicy } from "./mfa-gate";

type OrgRecord = {
  id: string;
  publicId: string;
  slug: string;
  name: string;
};

type WorkspaceRecord = {
  id: string;
  publicId: string;
  orgId: string;
  slug: string;
  name: string;
};

/**
 * One invitation by its public token, with the organization it names. The
 * token is the capability: the visitor holds no membership in the org yet, so
 * this is read before any tenant scope exists. `role` and `status` are the
 * stored strings (`org.invitations.role` is Title-cased); the caller maps them.
 */
export type InvitationRecord = {
  /** The row uuid, for the write that accepts or declines it. */
  invitationId: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  email: string;
  role: string;
  status: string;
  invitedAt: Date;
  expiresAt: Date | null;
};

export type SystemLookups = {
  /** The organization whose current slug is `slug`. */
  readonly orgBySlug: (slug: string) => Promise<OrgRecord | null>;
  /** The organization a redirect-enabled historical slug points at (most recent rename wins). */
  readonly orgBySlugHistory: (slug: string) => Promise<OrgRecord | null>;
  /** The workspace in `orgId` whose current slug is `slug`. */
  readonly workspaceBySlug: (
    orgId: string,
    slug: string,
  ) => Promise<WorkspaceRecord | null>;
  /** The workspace in `orgId` a redirect-enabled historical slug points at. */
  readonly workspaceBySlugHistory: (
    orgId: string,
    slug: string,
  ) => Promise<WorkspaceRecord | null>;
  /** The member's organization role, lowercased; null for a non-member. */
  readonly orgRole: (orgId: string, userId: string) => Promise<string | null>;
  /**
   * The viewer's membership of a workspace — the row id and their role,
   * lowercased — or null when they are not a member.
   */
  readonly workspaceMember: (
    workspaceId: string,
    userId: string,
  ) => Promise<{ id: string; role: string } | null>;
  /** The organization's MFA policy, or null when it has none. */
  readonly mfaPolicy: (orgId: string) => Promise<MfaPolicy | null>;
  readonly twoFactorEnabled: (userId: string) => Promise<boolean>;
  /** The invitation behind `token` (`invitations.public_id`), or null when none or its organization is gone. */
  readonly invitationByToken: (
    token: string,
  ) => Promise<InvitationRecord | null>;
};

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

export const systemLookups: SystemLookups = {
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

  async workspaceMember(workspaceId, userId) {
    // workspace_users.role is written in both casings, exactly as org_users.role
    // is: lowercase by the workspace create and bootstrap paths, TitleCase by
    // the IAM role names, under a case-insensitive CHECK over the canonical set
    // (packages/database/src/schema/workspace.ts:148). This is the one place
    // the casing is settled, so no reader downstream lowercases again.
    const rows = await withSystemDb((tx) =>
      tx
        .select({
          id: schema.workspaceUsers.id,
          role: schema.workspaceUsers.role,
        })
        .from(schema.workspaceUsers)
        .where(
          and(
            eq(schema.workspaceUsers.workspaceId, workspaceId),
            eq(schema.workspaceUsers.userId, userId),
          ),
        )
        .limit(1),
    );
    const row = rows[0];
    return row ? { id: row.id, role: row.role.toLowerCase() } : null;
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

  async invitationByToken(token) {
    const rows = await withSystemDb((tx) =>
      tx
        .select({
          id: schema.invitations.id,
          orgId: schema.invitations.orgId,
          email: schema.invitations.email,
          role: schema.invitations.role,
          status: schema.invitations.status,
          createdAt: schema.invitations.createdAt,
          expiresAt: schema.invitations.expiresAt,
        })
        .from(schema.invitations)
        .where(eq(schema.invitations.publicId, token))
        .limit(1),
    );
    const invitation = rows[0];
    if (!invitation) return null;
    const org = await orgById(invitation.orgId);
    if (!org) return null;
    return {
      invitationId: invitation.id,
      orgId: invitation.orgId,
      orgName: org.name,
      orgSlug: org.slug,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      invitedAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
    };
  },
};
