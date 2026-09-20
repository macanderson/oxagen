// org-role.ts — the role gate a handler runs itself.
//
// The kernel's IAM check allows every capability for a non-enterprise
// organisation (check-iam.ts, the `tier_gate` step), so a contract's
// `defaultRoles` is documentation for Free, Build and Scale orgs. A handler
// whose contract restricts roles calls `assertOrgRole` and refuses with
// `HandlerError { code: "forbidden" }` when the actor holds none of the named
// org roles, and none of the named workspace roles when the handler names
// those too (apps/app/ARCHITECTURE.md §3.2, INV-29). The class lives in
// @oxagen/oxagen so the API middleware maps it to 403 and the app's kernel
// seam to `denied` without either depending on this package.
//
// This module lives in @oxagen/iam rather than @oxagen/handlers so that
// packages/agent, which depends on @oxagen/iam and not on @oxagen/handlers,
// can run the same check. `packages/handlers/src/lib/api-key-authz.ts`
// re-exports `resolveActorOrgRole` for its existing callers.

import { schema, withOrgDb, type Tx } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import { and, eq, gt, isNull, or } from "drizzle-orm";

/** Which assignments a role lookup reads: org-wide, or one workspace's. */
type RoleScope =
  | { readonly kind: "org" }
  | { readonly kind: "workspace"; readonly workspaceId: string };

async function findActivePrincipalId(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<string | null> {
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
  return principalRow?.id ?? null;
}

/**
 * When a principal holds several roles in one scope at once, the most
 * privileged name wins. `iam.principal_role_assignments` is unique on
 * (principal, role, org), not on (principal, org), and the lookup carries no
 * ORDER BY, so taking whichever row Postgres returned first denied a user
 * holding both Admin and Member depending on plan/row order.
 */
const ROLE_PRECEDENCE = ["Owner", "Admin"] as const;

/**
 * A principal holds a handful of roles per scope; the bound only guards a
 * runaway row set, never which role is chosen.
 */
const ROLE_ASSIGNMENT_LIMIT = 50;

/**
 * The most privileged of `names` by `ROLE_PRECEDENCE`, else the first one,
 * else null. Used both to name a principal's single effective role and, in
 * `assertOrgRole`, to name which of the roles that satisfied a gate did so.
 */
function mostPrivileged(names: readonly string[]): string | null {
  return (
    ROLE_PRECEDENCE.find((name) => names.includes(name)) ?? names[0] ?? null
  );
}

/**
 * Every unexpired role name assigned to `principalId` in `scope`. An org-wide
 * assignment has `workspace_id IS NULL` and an org-scoped role; a workspace
 * assignment carries the workspace id and a workspace-scoped role.
 *
 * All of them are returned rather than one, because a gate that names several
 * acceptable roles has to see every role the principal holds: choosing one
 * first and comparing that against the set discards the assignment that would
 * have passed (see `assertOrgRole`).
 */
async function findAssignedRoles(
  tx: Tx,
  principalId: string,
  orgId: string,
  scope: RoleScope,
): Promise<string[]> {
  const assigned = await tx
    .select({ roleName: schema.roles.name })
    .from(schema.principalRoleAssignments)
    .innerJoin(
      schema.roles,
      eq(schema.roles.id, schema.principalRoleAssignments.roleId),
    )
    .where(
      and(
        eq(schema.principalRoleAssignments.principalId, principalId),
        eq(schema.principalRoleAssignments.orgId, orgId),
        eq(schema.roles.scopeKind, scope.kind),
        scope.kind === "org"
          ? isNull(schema.principalRoleAssignments.workspaceId)
          : eq(schema.principalRoleAssignments.workspaceId, scope.workspaceId),
        isNull(schema.principalRoleAssignments.deletedAt),
        or(
          isNull(schema.principalRoleAssignments.expiresAt),
          gt(schema.principalRoleAssignments.expiresAt, new Date()),
        ),
      ),
    )
    .limit(ROLE_ASSIGNMENT_LIMIT);
  return assigned.map((row) => row.roleName);
}

/**
 * Resolve ONE of the acting user's org-scoped role names, or null when they
 * have no active principal / unexpired org-role assignment in this org.
 *
 * A principal may hold several org-wide roles at once — `iam.principal_role_
 * assignments` is unique on (principal, role, org), not on (principal, org).
 * Every caller asks "is it in {Owner, Admin}?", so the most privileged role
 * the principal holds wins (`ROLE_PRECEDENCE`); taking whichever row Postgres
 * returned first denied a user holding both Admin and Member depending on
 * plan/row order.
 *
 * Time-bounded (JIT) assignments are honored the same way the kernel resolver
 * honors them (`isExpired` in packages/oxagen/src/iam/resolve.ts): an
 * assignment whose `expires_at` is in the past no longer grants its role.
 *
 * Runs inside the caller's tenant scope, reading ORGANISATION-WIDE
 * (`withOrgDb`, ADR-086). Every one of the three reads below runs on org-level
 * surfaces that carry no workspace, where `withTenantDb` now refuses a read of
 * `iam.principals` (`workspace_nullable`) or `auth.api_keys` (`standard`)
 * outright rather than narrowing it. The narrowing that matters is in the
 * queries: `findActivePrincipalId` matches (org, parent_user_id,
 * kind='human', active), which a workspace-scoped agent principal cannot
 * satisfy, and `findAssignedRoles` pins `workspace_id IS NULL` for an org scope
 * and `workspace_id = <the workspace>` for a workspace one. `withOrgDb`
 * resolves the same data plane `withTenantDb` would, so nothing moves database.
 */
export async function resolveActorOrgRole(
  orgId: string,
  userId: string,
): Promise<string | null> {
  return mostPrivileged(await resolveActorOrgRoles(orgId, userId));
}

/**
 * Every org-scoped role name the acting user holds in this org, unordered and
 * possibly empty. `resolveActorOrgRole` reduces this to one name; a gate that
 * accepts several roles reads the list instead, so that a principal holding
 * both Admin and Billing is not refused a Billing-gated capability because
 * Admin outranks Billing in `ROLE_PRECEDENCE` (apps/app/ARCHITECTURE.md §3.2).
 */
export async function resolveActorOrgRoles(
  orgId: string,
  userId: string,
  transaction?: Tx,
): Promise<string[]> {
  const read = async (tx: Tx) => {
    const principalId = await findActivePrincipalId(tx, orgId, userId);
    if (principalId === null) return [];
    return findAssignedRoles(tx, principalId, orgId, { kind: "org" });
  };
  return transaction ? read(transaction) : withOrgDb(read);
}

/**
 * The same lookup for the user's role in one workspace of the org: an
 * unexpired workspace-scoped assignment on that workspace, or null, chosen by
 * the same precedence rule `resolveActorOrgRole` documents.
 */
export async function resolveActorWorkspaceRole(
  orgId: string,
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  return mostPrivileged(
    await resolveActorWorkspaceRoles(orgId, workspaceId, userId),
  );
}

/** Every role the user holds on that one workspace, the plural of the above. */
export async function resolveActorWorkspaceRoles(
  orgId: string,
  workspaceId: string,
  userId: string,
  transaction?: Tx,
): Promise<string[]> {
  // Org-wide for the same reason, and for one more: `assertOrgRole` asks for
  // workspace roles whenever the required set names any, and an org-only ctx
  // carries ORG_ONLY_WORKSPACE_ID rather than nothing. So this runs under an
  // org-only scope in ordinary service. The `workspace_id = <sentinel>`
  // predicate matches no assignment, which is the right answer — an org-only
  // call holds no workspace role — and it is the query that says so, not RLS.
  const read = async (tx: Tx) => {
    const principalId = await findActivePrincipalId(tx, orgId, userId);
    if (principalId === null) return [];
    return findAssignedRoles(tx, principalId, orgId, {
      kind: "workspace",
      workspaceId,
    });
  };
  return transaction ? read(transaction) : withOrgDb(read);
}

/** The credential fields of a `CapabilityContext` the acting user is read from. */
export interface ActingCredential {
  readonly orgId: string;
  readonly userId: string | null;
  readonly apiKeyId: string | null;
}

/**
 * The user a call acts as: the signed-in user, or, for an API-key call (the
 * only credential MCP accepts), the key's creator
 * (`auth.api_keys.created_by_id`), the mapping the kernel's enterprise
 * IAM path makes (fetch-authz.ts); `assign_agent_role` reads its delegation
 * ceiling for this user. A deleted key, a key of another org, a key with no recorded
 * creator, or no credential at all resolves to null, which `assertOrgRole`
 * refuses as `no_principal`. Every handler that runs `assertOrgRole` passes
 * this user to it and records it as the actor, so a key acts with its
 * creator's current org role and no more (apps/app/ARCHITECTURE.md §9,
 * 2026-09-15; packages/handlers/src/role-check.test.ts enforces the call).
 *
 * Runs inside the caller's tenant scope, reading organisation-wide
 * (`withOrgDb`). `auth.api_keys` is `standard`, so under an org-only scope the
 * old tenant read answered EMPTILY and every API-key call on an org-level
 * surface resolved to no principal and was refused `no_principal` — silently,
 * because an empty result and a genuinely unknown key are the same answer. The
 * key is matched on its own id with the org fence written out, and RLS still
 * holds the org boundary.
 */
export async function resolveActingUserId(
  ctx: ActingCredential,
): Promise<string | null> {
  if (ctx.userId) return ctx.userId;
  const apiKeyId = ctx.apiKeyId;
  if (!apiKeyId) return null;
  return withOrgDb(async (tx) => {
    const [keyRow] = await tx
      .select({ createdById: schema.apiKeys.createdById })
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.id, apiKeyId),
          eq(schema.apiKeys.orgId, ctx.orgId),
          isNull(schema.apiKeys.deletedAt),
        ),
      )
      .limit(1);
    return keyRow?.createdById ?? null;
  });
}

/** The fields of a `CapabilityContext` the role gate reads. */
export interface OrgRoleActor {
  readonly orgId: string;
  /** The workspace the call is scoped to; read only when `workspace` roles are required. */
  readonly workspaceId?: string;
  readonly userId: string | null;
}

/** The roles a handler accepts, by IAM role name (`iam.roles.name`). */
export interface OrgRoleRequirement {
  /** Org-wide roles that satisfy the gate. */
  readonly org: readonly string[];
  /** Roles on `ctx.workspaceId` that satisfy it as well; absent for org-only gates. */
  readonly workspace?: readonly string[];
}

/**
 * Refuse unless the signed-in user holds one of `required.org` in `ctx.orgId`,
 * or — when the handler names `required.workspace` — one of those roles on
 * `ctx.workspaceId`.
 *
 * Roles are assigned to human principals (`iam.principals.parent_user_id`
 * with `kind = 'human'`), so the gate resolves `ctx.userId` and nothing else.
 * A context with no user is refused with reason `no_principal` before any
 * query. The gate makes no key-to-creator mapping itself: every handler
 * resolves the acting user with `resolveActingUserId` and passes it as
 * `userId`. Reason `org_role_required` covers a user with no active
 * principal, no qualifying role, or a role outside both sets. The workspace
 * leg runs only after the org leg failed, and only when the context names a
 * workspace. Returns the role name that satisfied the check so a handler can
 * record it; when several of the user's roles satisfy it, the most privileged
 * of those by `ROLE_PRECEDENCE`.
 *
 * The gate reads every role the principal holds, not the one
 * `resolveActorOrgRole` would name. `principal_role_assignments` allows a
 * principal several roles per scope, and picking one by precedence before
 * comparing it against `required` throws away an assignment that would have
 * passed: a user holding both Admin and Billing resolves to Admin, which is
 * outside `{Owner, Billing}`, so `purchase_credits` refused a billing member
 * for holding one role too many.
 */
export async function assertOrgRole(
  ctx: OrgRoleActor,
  required: OrgRoleRequirement,
  transaction?: Tx,
): Promise<string> {
  if (!ctx.userId) {
    throw new HandlerError({
      code: "forbidden",
      reason: "no_principal",
      message: "No signed-in user on the request",
    });
  }
  const orgRoles = await resolveActorOrgRoles(
    ctx.orgId,
    ctx.userId,
    transaction,
  );
  const orgMatch = mostPrivileged(
    orgRoles.filter((name) => required.org.includes(name)),
  );
  if (orgMatch !== null) return orgMatch;

  if (required.workspace && ctx.workspaceId) {
    const acceptedOnWorkspace = required.workspace;
    const wsRoles = await resolveActorWorkspaceRoles(
      ctx.orgId,
      ctx.workspaceId,
      ctx.userId,
      transaction,
    );
    const wsMatch = mostPrivileged(
      wsRoles.filter((name) => acceptedOnWorkspace.includes(name)),
    );
    if (wsMatch !== null) return wsMatch;
  }

  const accepted = [
    `org roles ${required.org.join(", ")}`,
    ...(required.workspace
      ? [`workspace roles ${required.workspace.join(", ")}`]
      : []),
  ].join(" or ");
  throw new HandlerError({
    code: "forbidden",
    reason: "org_role_required",
    message: `Requires one of the ${accepted}`,
  });
}
