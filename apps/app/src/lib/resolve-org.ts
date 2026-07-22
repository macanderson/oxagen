import "server-only";
import { cache } from "react";
import { notFound, permanentRedirect } from "next/navigation";
import { eq, and, desc } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import { isValidSlug } from "./slug";
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
  // `description` lives in the workspaces.settings JSONB bag under the
  // `description` key — the SAME key written by the workspace.settings.write
  // handler (mapWorkspaceSettingsRow). Exposed here so the General settings
  // page can render the saved value (persistence is observable).
  description: string;
  // Avatar value: https URL or designed-avatar spec string (avatar:v1:…),
  // written by workspace.settings.write. Null when unset.
  avatarUrl: string | null;
}

// Per-request memoization keeps slug → row resolution at one query per
// boundary, even when several RSCs in the same render need the tenant.
export const resolveOrg = cache(async (slug: string): Promise<ResolvedOrg> => {
  // Reject anything that could never be a real org slug (static/metadata paths
  // like favicon.ico, robots.txt that fall through to [orgSlug]) BEFORE the DB
  // round-trip — a malformed slug is a guaranteed 404, not a lookup. — OXA-1779
  if (!isValidSlug(slug)) notFound();
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

/**
 * History-aware org resolver. Tries the current slug first; on a miss, looks
 * up org_slug_history for a redirect-enabled entry and resolves the org from
 * its id. Returns the resolved org WITH the canonical slug so the caller can
 * compare against the URL slug and issue a 308 permanent redirect when they
 * differ (spec §4.5; OXA-1779).
 *
 * Why this is separate from resolveOrg(): resolveOrg's contract is "current
 * slug → org or 404". Several call sites depend on that contract (the writer
 * actions, IAM gates), so widening it would be unsafe. The layout uses this
 * stricter variant; everything downstream of the layout continues using
 * resolveOrg() with the (now canonical) slug.
 */
export const resolveOrgWithRedirect = cache(
  async (slug: string): Promise<ResolvedOrg> => {
    // Short-circuit slugs that can't be valid (favicon.ico, robots.txt,
    // sitemap.xml, … all fall through to [orgSlug]) — skip BOTH the org query
    // and the slug-history fallback: a malformed slug was never a real org, so
    // it can't be in org_slug_history either. — OXA-1779
    if (!isValidSlug(slug)) notFound();
    const direct = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.slug, slug))
        .limit(1),
    );
    if (direct[0]) {
      const row = direct[0];
      return {
        id: row.id,
        publicId: row.publicId,
        name: row.name,
        slug: row.slug,
      };
    }
    // History fallback. ORDER BY changed_at DESC handles slug recycling — when
    // an old slug appears in multiple history rows (because it was freed and
    // re-used by another org), the most recent rename wins. redirect_enabled
    // gives admins a kill switch (404 the old URL on demand) without deleting
    // the audit row.
    const historyRows = await withSystemDb((tx) =>
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
    const history = historyRows[0];
    if (!history) notFound();
    return resolveOrgById(history.orgId);
  },
);

const resolveOrgById = cache(async (orgId: string): Promise<ResolvedOrg> => {
  const rows = await withSystemDb((tx) =>
    tx
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId))
      .limit(1),
  );
  const row = rows[0];
  // The org could have been deleted between writing the history row and a
  // bookmark click landing here. Treat as 404 — there is no canonical URL to
  // redirect to.
  if (!row) notFound();
  return {
    id: row.id,
    publicId: row.publicId,
    name: row.name,
    slug: row.slug,
  };
});

/**
 * Convenience layered on top of resolveOrgWithRedirect for the [orgSlug]
 * layout: resolve the org and, when the URL's slug is stale, throw a 308
 * permanent redirect to the canonical URL with the rest of the path preserved.
 *
 * The layout passes the full pathname + search; this helper rewrites only the
 * first path segment (the org slug). Returns the canonical org on a current-
 * slug match so the caller can continue rendering without an extra round trip.
 */
export async function resolveOrgOrRedirect(
  urlSlug: string,
  pathname: string,
  search: string,
): Promise<ResolvedOrg> {
  const org = await resolveOrgWithRedirect(urlSlug);
  if (org.slug !== urlSlug) {
    permanentRedirect(rewriteOrgSlug(pathname, urlSlug, org.slug) + search);
  }
  return org;
}

function rewriteOrgSlug(
  pathname: string,
  oldSlug: string,
  newSlug: string,
): string {
  // pathname is always /{orgSlug}/... — replace only the first segment so a
  // path like /old/old/foo stays /new/old/foo (the second "old" is real data).
  if (pathname === `/${oldSlug}`) return `/${newSlug}`;
  const prefix = `/${oldSlug}/`;
  if (pathname.startsWith(prefix))
    return `/${newSlug}/${pathname.slice(prefix.length)}`;
  // Defensive fallback: redirect to the org root rather than render at the
  // stale URL. Should never trigger if the layout's params actually came from
  // the request URL.
  return `/${newSlug}`;
}

export const resolveWorkspace = cache(
  async (orgId: string, slug: string): Promise<ResolvedWorkspace> => {
    // Same guard as resolveOrg: reject impossible slugs before the DB round-trip
    // (static paths like /{org}/favicon.ico reach the nested [workspaceSlug]
    // route). — OXA-1779
    if (!isValidSlug(slug)) notFound();
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
    const row = rows[0];
    if (!row) notFound();
    return mapWorkspaceRow(row);
  },
);

function mapWorkspaceRow(
  row: typeof schema.workspaces.$inferSelect,
): ResolvedWorkspace {
  // description is a real column now (promoted out of the settings JSONB bag —
  // audit §1.7), matching mapWorkspaceSettingsRow.
  const description = row.description ?? "";
  return {
    id: row.id,
    publicId: row.publicId,
    orgId: row.orgId,
    name: row.name,
    slug: row.slug,
    description,
    avatarUrl: row.avatarUrl ?? null,
  };
}

/**
 * History-aware workspace resolver. Same shape as resolveOrgWithRedirect but
 * scoped to (orgId, oldSlug) — workspace slugs are only unique within their
 * org, so the lookup never collides across tenants (spec §4.5; OXA-1779).
 */
export const resolveWorkspaceWithRedirect = cache(
  async (orgId: string, slug: string): Promise<ResolvedWorkspace> => {
    // Skip both the workspace query and the slug-history fallback for slugs that
    // can't be valid (static/metadata paths under an org). — OXA-1779
    if (!isValidSlug(slug)) notFound();
    const direct = await withSystemDb((tx) =>
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
    if (direct[0]) return mapWorkspaceRow(direct[0]);

    const historyRows = await withSystemDb((tx) =>
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
    const history = historyRows[0];
    if (!history) notFound();

    const rows = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.orgId, orgId),
            eq(schema.workspaces.id, history.workspaceId),
          ),
        )
        .limit(1),
    );
    const row = rows[0];
    if (!row) notFound();
    return mapWorkspaceRow(row);
  },
);

/**
 * Resolve the workspace and 308-redirect when the URL's workspace slug is
 * stale (the orgSlug is preserved verbatim — only the workspace segment moves).
 */
export async function resolveWorkspaceOrRedirect(
  orgId: string,
  orgSlug: string,
  urlWorkspaceSlug: string,
  pathname: string,
  search: string,
): Promise<ResolvedWorkspace> {
  const ws = await resolveWorkspaceWithRedirect(orgId, urlWorkspaceSlug);
  if (ws.slug !== urlWorkspaceSlug) {
    permanentRedirect(
      rewriteWorkspaceSlug(pathname, orgSlug, urlWorkspaceSlug, ws.slug) +
        search,
    );
  }
  return ws;
}

function rewriteWorkspaceSlug(
  pathname: string,
  orgSlug: string,
  oldWs: string,
  newWs: string,
): string {
  // pathname is /{orgSlug}/{workspaceSlug}/... — rewrite only the workspace
  // segment. The org slug is passed through to anchor the match (so a literal
  // workspace name that happens to equal another path segment downstream is
  // not accidentally rewritten).
  if (pathname === `/${orgSlug}/${oldWs}`) return `/${orgSlug}/${newWs}`;
  const prefix = `/${orgSlug}/${oldWs}/`;
  if (pathname.startsWith(prefix)) {
    return `/${orgSlug}/${newWs}/${pathname.slice(prefix.length)}`;
  }
  // Defensive fallback — should never trigger for a layout invoked from this
  // path. Land on the workspace root rather than a stale URL.
  return `/${orgSlug}/${newWs}`;
}

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

/**
 * Roles permitted to manage billing (mirror of the billing actions gate).
 * Exported (like {@link SECURITY_MANAGER_ROLES}) so a page can pair it with
 * the read-only {@link getOrgRole} for UI-gating (e.g. hiding a billing
 * control for a non-manager) without re-deriving or duplicating the role
 * list — see security/audit/page.tsx's `isManager` for the established
 * pattern this mirrors.
 */
export const BILLING_MANAGER_ROLES = new Set(["owner", "admin", "billing"]);

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

/** Roles permitted to perform org-administrative actions (Owner/Admin). */
const ORG_ADMIN_ROLES = new Set(["owner", "admin"]);

/**
 * Assert that the user is a member of the org AND holds an administrative role
 * (owner/admin). Calls `notFound()` otherwise — a non-admin is treated like a
 * non-member (404), consistent with {@link assertOrgMember}.
 *
 * Use for org-administrative actions whose contract declares Owner/Admin-only
 * authorization but that are NOT specifically billing, plugin (MCP), or
 * compliance-export scoped (each of which has its own domain-named gate). The
 * canonical case is developer API-key management (`api.key.create/revoke/rotate`,
 * `sensitivity: "high"`, `defaultRoles.org = { Owner, Admin }`): minting a key
 * hands out programmatic org access, so membership alone is not sufficient.
 * Mirrors the kernel IAM role gate that the API/MCP surfaces get for free but
 * which invoke() from apps/app skips.
 */
export const assertOrgAdmin = cache(
  async (orgId: string, userId: string): Promise<void> => {
    const role = await getOrgRole(orgId, userId);
    if (!role || !ORG_ADMIN_ROLES.has(role)) {
      notFound();
    }
  },
);

/** Roles permitted to export signed compliance evidence (SOC 2 audit export). */
export const SECURITY_MANAGER_ROLES = new Set(["owner", "admin"]);

/**
 * Assert that the given user is a member of the given workspace (via
 * workspace.workspace_users). Calls `notFound()` if the user has no row,
 * ensuring a session scoped to workspace A cannot read workspace B — even
 * within the same org. 404 (not 403) is deliberate: without the
 * `authInterrupts` flag, Next.js only exposes `notFound()` for hard
 * navigation interrupts; 404 is indistinguishable from "workspace not found"
 * to an attacker, which is the correct information-hiding behaviour.
 *
 * Call AFTER resolveWorkspace() in any server-side path that renders
 * per-workspace content. The workspace layout (`[workspaceSlug]/layout.tsx`)
 * is the canonical enforcement point.
 */
export const assertWorkspaceMember = cache(
  async (workspaceId: string, userId: string): Promise<void> => {
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
    if (rows.length === 0) {
      notFound();
    }
  },
);

export interface WorkspaceScope {
  orgId: string;
  workspaceId: string;
}

/**
 * Canonical tenant-scope seam for API routes / server actions that receive a
 * `workspaceId` from the client but NOT the org/workspace slugs.
 *
 * Resolves the workspace's owning org AND asserts membership in a single query,
 * returning BOTH ids. Returns `null` when the workspace is unknown OR the user
 * is not a member (the two are intentionally indistinguishable — no existence
 * leak, mirroring resolveOrg/assertWorkspaceMember's notFound() behaviour).
 *
 * Use this instead of hand-rolling `orgId` resolution in a route handler. Never
 * pass an empty/placeholder `orgId` into `invoke()` — a workspace-scoped
 * capability needs a real org id (the RLS GUCs and handler filters depend on
 * it), and an empty id silently matches zero rows ("active tenant not found").
 *
 * Per-request memoized.
 */
export const resolveWorkspaceScope = cache(
  async (
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceScope | null> => {
    if (!workspaceId) return null;
    const rows = await withSystemDb((tx) =>
      tx
        .select({ orgId: schema.workspaces.orgId })
        .from(schema.workspaces)
        .innerJoin(
          schema.workspaceUsers,
          and(
            eq(schema.workspaceUsers.workspaceId, schema.workspaces.id),
            eq(schema.workspaceUsers.userId, userId),
          ),
        )
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1),
    );
    const row = rows[0];
    if (!row) return null;
    return { orgId: row.orgId, workspaceId };
  },
);

/**
 * Return the caller's role in the org, or null when they are not a member.
 * Read-only (does NOT 404) — use for UI gating (e.g. enabling/disabling the
 * audit-export button). For a hard server gate use {@link assertSecurityManager}.
 */
export const getOrgRole = cache(
  async (orgId: string, userId: string): Promise<string | null> => {
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
    return rows[0]?.role ?? null;
  },
);

/**
 * Assert the user holds a security-management role (owner/admin) in the org.
 * Calls `notFound()` otherwise. Use on the signed audit-export endpoint so a
 * non-manager cannot pull the org's full audit trail.
 */
export const assertSecurityManager = cache(
  async (orgId: string, userId: string): Promise<void> => {
    const role = await getOrgRole(orgId, userId);
    if (!role || !SECURITY_MANAGER_ROLES.has(role)) {
      notFound();
    }
  },
);
