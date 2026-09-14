// org-role.ts — the role gate a handler runs itself.
//
// The kernel's IAM check allows every capability for a non-enterprise
// organisation (check-iam.ts, the `tier_gate` step), so a contract's
// `defaultRoles` is documentation for Free, Build and Scale orgs. A handler
// whose contract restricts roles calls `assertOrgRole` and refuses with
// `HandlerError { code: "forbidden" }` when the actor holds none of the named
// org roles (apps/app/ARCHITECTURE.md §3.2, INV-29). The class lives in
// @oxagen/oxagen so the API middleware maps it to 403 and the app's kernel
// seam to `denied` without either depending on this package.
//
// This module lives in @oxagen/iam rather than @oxagen/handlers so that
// packages/agent, which depends on @oxagen/iam and not on @oxagen/handlers,
// can run the same check. `packages/handlers/src/lib/api-key-authz.ts`
// re-exports `resolveActorOrgRole` for its existing callers.

import { schema, withTenantDb } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import { and, eq, gt, isNull, or } from "drizzle-orm";

/**
 * Resolve ONE of the acting user's org-scoped role names, or null when they
 * have no active principal / unexpired org-role assignment in this org.
 *
 * A principal may hold several org-wide roles at once — `iam.principal_role_
 * assignments` is unique on (principal, role, org), not on (principal, org) —
 * and this query takes the first row Postgres returns with no ORDER BY, so
 * WHICH role comes back is not deterministic. Every caller only asks "is it in
 * {Owner, Admin}?", so a user holding both Admin and Member can be denied
 * depending on plan/row order. Fixing that means asking "does ANY assigned role
 * qualify?" instead of resolving a single name, which changes what this helper
 * promises to its callers — tracked separately, not patched here.
 *
 * Time-bounded (JIT) assignments are honored the same way the kernel resolver
 * honors them (`isExpired` in packages/oxagen/src/iam/resolve.ts): an
 * assignment whose `expires_at` is in the past no longer grants its role.
 *
 * Runs inside the caller's tenant scope (`withTenantDb`): the kernel enters it
 * before a scoped handler runs.
 */
export async function resolveActorOrgRole(
  orgId: string,
  userId: string,
): Promise<string | null> {
  return withTenantDb(async (tx) => {
    const [principalRow] = await tx
      .select({ id: schema.principals.id })
      .from(schema.principals)
      .where(
        and(
          eq(schema.principals.orgId, orgId),
          eq(schema.principals.parentUserId, userId),
          eq(schema.principals.kind, "human"),
          eq(schema.principals.status, "active"),
        ),
      )
      .limit(1);

    if (!principalRow) return null;

    const [praRow] = await tx
      .select({ roleName: schema.roles.name })
      .from(schema.principalRoleAssignments)
      .innerJoin(
        schema.roles,
        eq(schema.roles.id, schema.principalRoleAssignments.roleId),
      )
      .where(
        and(
          eq(schema.principalRoleAssignments.principalId, principalRow.id),
          eq(schema.principalRoleAssignments.orgId, orgId),
          eq(schema.roles.scopeKind, "org"),
          isNull(schema.principalRoleAssignments.workspaceId),
          isNull(schema.principalRoleAssignments.deletedAt),
          or(
            isNull(schema.principalRoleAssignments.expiresAt),
            gt(schema.principalRoleAssignments.expiresAt, new Date()),
          ),
        ),
      )
      .limit(1);

    return praRow?.roleName ?? null;
  });
}

/** The fields of a `CapabilityContext` the role gate reads. */
export interface OrgRoleActor {
  readonly orgId: string;
  readonly userId: string | null;
  readonly apiKeyId: string | null;
}

/** The org roles a handler accepts, by IAM role name (`iam.roles.name`). */
export interface OrgRoleRequirement {
  readonly org: readonly string[];
}

/**
 * Refuse unless the actor holds one of `required.org` in `ctx.orgId`.
 *
 * Throws `HandlerError { code: "forbidden" }` with reason `no_principal` when
 * the context carries neither a user nor an API key, and `org_role_required`
 * when the resolved role is absent or not in the set. Returns the role that
 * satisfied the check so a handler can record it.
 */
export async function assertOrgRole(
  ctx: OrgRoleActor,
  required: OrgRoleRequirement,
): Promise<string> {
  const actorId = ctx.userId ?? ctx.apiKeyId;
  if (!actorId) {
    throw new HandlerError({
      code: "forbidden",
      reason: "no_principal",
      message: "No authenticated principal",
    });
  }
  const role = await resolveActorOrgRole(ctx.orgId, actorId);
  if (role === null || !required.org.includes(role)) {
    throw new HandlerError({
      code: "forbidden",
      reason: "org_role_required",
      message: `Requires one of the org roles ${required.org.join(", ")}`,
    });
  }
  return role;
}
