// fetch-authz.ts — fetch IAM authorization data from Postgres (OXA-1390, Phase 3).
//
// Reads the IAM tables (principals, grants, role_grants, roles, policies) for
// a given principal/scope, so the pure resolver can decide without any I/O.
//
// GRACEFUL DEGRADATION: if the IAM tables do not exist yet (Postgres error
// 42P01 — "relation does not exist"), returns empty AuthzData. The resolver
// will fall through to rule 8 and use each contract's defaultEffect. This
// lets the app boot and operate in dev environments where the IAM migration
// has not been run. Remove this fallback after `pnpm db:migrate` is standard.

import { withTenantDb } from "@oxagen/database";
import { eq, and, inArray, isNull, or, gt, sql } from "drizzle-orm";
import { schema } from "@oxagen/database";
import type { Grant, Role, RoleGrant, Policy } from "@oxagen/oxagen/iam";
import type { ResolvedPrincipal } from "@oxagen/oxagen";
import { logger } from "./logger";

export interface AuthzData {
  principal: ResolvedPrincipal | null;
  grants: readonly Grant[];
  roles: readonly Role[];
  roleGrants: readonly RoleGrant[];
  policies: readonly Policy[];
}

const EMPTY_AUTHZ: AuthzData = {
  principal: null,
  grants: [],
  roles: [],
  roleGrants: [],
  policies: [],
};

/**
 * Sentinel principal id used for the fail-closed deny emitted for API-key
 * callers we cannot yet resolve to a real service principal. Distinct from the
 * all-zero principal the kernel substitutes so denials are traceable.
 */
const UNRESOLVED_SERVICE_PRINCIPAL_ID = "00000000-0000-0000-0000-0000000000ff";

/**
 * Build a fail-closed AuthzData for an API-key-authenticated request that we
 * cannot resolve to a service principal.
 *
 * Service principals are not yet linked to API keys in the data model
 * (api_keys carries no principal_id, and principals has no parent_api_key_id),
 * so we cannot resolve role grants for an API-key caller. Returning EMPTY_AUTHZ
 * here would let the resolver fall through to rule 8 (contract defaultEffect):
 * any capability whose defaultEffect is "allow" would be granted to every API
 * key regardless of the enterprise org's role-grant matrix, and an explicit
 * role-grant deny would be silently ignored — an IAM bypass on the
 * machine-to-machine surface (this path only runs for enterprise orgs; the tier
 * gate in check-iam.ts bypasses the resolver for everyone else).
 *
 * Instead we fail closed by emitting a synthetic org-enforced DENY policy for
 * the requested capability. resolve()'s rule 2 (org enforced deny) is a hard
 * stop that overrides defaultEffect, so the request is denied rather than
 * degraded. Replace this with a real service-principal lookup once API keys are
 * linked to principals.
 */
function denyApiKeyAuthz(orgId: string, workspaceId: string, capability: string): AuthzData {
  return {
    principal: {
      id: UNRESOLVED_SERVICE_PRINCIPAL_ID,
      kind: "service",
      orgId,
      workspaceId,
    },
    grants: [],
    roles: [],
    roleGrants: [],
    policies: [
      {
        capabilityId: capability,
        scopeKind: "org",
        scopeId: orgId,
        effect: "deny",
        enforced: true,
      },
    ],
  };
}

/**
 * Postgres error code for "relation does not exist". Thrown when the IAM
 * migration has not been applied to the target database.
 */
const PG_UNDEFINED_TABLE = "42P01";

function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<string, unknown>)["code"] === PG_UNDEFINED_TABLE
  );
}

export interface FetchAuthzArgs {
  /** The user/apiKey acting on behalf of an org. */
  userId: string | null;
  apiKeyId: string | null;
  orgId: string;
  workspaceId: string;
  capability: string;
}

/**
 * Load all IAM authorization data needed by the resolver for a single
 * invocation. Returns EMPTY_AUTHZ gracefully if the IAM tables are absent.
 */
export async function fetchAuthz(args: FetchAuthzArgs): Promise<AuthzData> {
  try {
    return await _fetchAuthz(args);
  } catch (err) {
    if (isUndefinedTable(err)) {
      // IAM migration not yet applied — log a warning and fall back.
      logger.warn(
        { err },
        "[iam] IAM tables not found (Postgres 42P01). Falling back to defaultEffect. " +
          "Run `pnpm db:migrate` to apply the IAM foundation migration.",
      );
      return EMPTY_AUTHZ;
    }
    throw err;
  }
}

async function _fetchAuthz(args: FetchAuthzArgs): Promise<AuthzData> {
  // grants/roles/policies are scoped by orgId (tenant isolation); the pure
  // resolver applies workspace-scope matching against scope.workspaceId for
  // those (see resolve.ts), so fetching all org rows and filtering in-memory
  // keeps the query count flat. Role *assignments*
  // (principal_role_assignments) can THEMSELVES be workspace-scoped, however,
  // so we must filter those by workspaceId here — see the PRA query below.
  //
  // RLS over-filtering analysis (OXA-1515): IAM tables (principals, grants,
  // roles, role_grants, policies, principal_role_assignments) have
  // workspace_nullable RLS policies — rows where workspace_id IS NULL (org-wide
  // IAM rows) pass through alongside current-workspace rows. All cross-workspace
  // org-wide IAM reads (roles, policies, org-wide PRAs) therefore remain
  // correctly visible inside withTenantDb. No query is over-filtered.
  const { userId, apiKeyId, orgId, workspaceId, capability } = args;

  // Resolve the principal from the userId (human kind).
  if (!userId) {
    // API-key-authenticated request (userId null, apiKeyId set): we cannot yet
    // resolve a service principal from the API key, so FAIL CLOSED rather than
    // fall through to defaultEffect (which would bypass enterprise role grants).
    // See denyApiKeyAuthz for the full rationale.
    if (apiKeyId) return denyApiKeyAuthz(orgId, workspaceId, capability);
    // No user and no API key — nothing to resolve.
    return EMPTY_AUTHZ;
  }

  return withTenantDb(async (tx) => {
    const principalRows = await tx
      .select()
      .from(schema.principals)
      .where(
        and(
          eq(schema.principals.orgId, orgId),
          // Match by the human user's ID stored in parent_user_id for humans.
          eq(schema.principals.parentUserId, userId),
        ),
      )
      .limit(1);

    const principalRow = principalRows[0];
    if (!principalRow) return EMPTY_AUTHZ;

    const principal: ResolvedPrincipal = {
      id: principalRow.id,
      kind: principalRow.kind as "human" | "agent" | "service",
      orgId: principalRow.orgId,
      workspaceId: principalRow.workspaceId,
    };

    // Queries 2 (grants), 3 (roles), and 5 (policies) are all independent of each
    // other — they only need principalRow.id / orgId / capability, all of which
    // are already known. Run them in parallel, then run query 4 (roleGrants) once
    // roleIds from query 3 is available. This collapses 4 serial round-trips into
    // 2 parallel batches, yielding ~3–4x latency reduction on the hot IAM path.

    // Batch 1: roles fire; grants + policies tables were dropped in migration
    // 0027 (grants/policies replaced by role-based IAM). Return empty arrays so
    // the resolver falls through to role-based evaluation (rules 4–6).
    const [grantRows, roleRows, policyRows] = await Promise.all([
      Promise.resolve([] as Grant[]),
      // Query 3 — all roles in this org (roleGrants depends on these ids).
      tx
        .select()
        .from(schema.roles)
        .where(eq(schema.roles.orgId, orgId)),
      Promise.resolve([] as Policy[]),
    ]);

    const grants: Grant[] = grantRows;

    // Batch 2: roleGrants depends on roleIds from the roles query above.
    // Also load principal_role_assignments for this principal to determine
    // which roles they are actually a member of (OXA-1498 -- replaces the
    // prior "all principals in this org are members of all roles" shortcut).
    const roleIds = roleRows.map((r) => r.id);

    // Query 4a — role_grants for these roles and this capability.
    // Query 4b — role assignments for this principal in this org/workspace.
    //   Include org-wide (workspaceId IS NULL) and workspace-scoped
    //   (workspaceId = ctx workspaceId) assignments. Non-deleted only.
    const [roleGrantRows, praRows] = await Promise.all([
      roleIds.length > 0
        ? tx
            .select()
            .from(schema.roleGrants)
            .where(
              and(
                inArray(schema.roleGrants.roleId, roleIds),
                eq(schema.roleGrants.capabilityId, capability),
              ),
            )
        : Promise.resolve([] as (typeof schema.roleGrants.$inferSelect)[]),
      tx
        .select({ roleId: schema.principalRoleAssignments.roleId })
        .from(schema.principalRoleAssignments)
        .where(
          and(
            eq(schema.principalRoleAssignments.principalId, principalRow.id),
            eq(schema.principalRoleAssignments.orgId, orgId),
            // Include assignments that are not soft-deleted.
            isNull(schema.principalRoleAssignments.deletedAt),
            // Exclude expired JIT assignments (expires_at in the past). A NULL
            // expires_at means a permanent (non-JIT) assignment.
            or(
              isNull(schema.principalRoleAssignments.expiresAt),
              gt(schema.principalRoleAssignments.expiresAt, sql`now()`),
            ),
            // Honour the assignment's workspace scope: include org-wide
            // assignments (workspace_id IS NULL) and assignments scoped to the
            // workspace this request targets. Without this predicate a
            // workspace-scoped role would leak org-wide (granting role X in
            // workspace B for an assignment made only in workspace A).
            or(
              isNull(schema.principalRoleAssignments.workspaceId),
              eq(schema.principalRoleAssignments.workspaceId, workspaceId),
            ),
          ),
        ),
    ]);

    // Build the set of role IDs this principal is actually a member of.
    // If the principal_role_assignments table has no rows for this principal
    // (e.g. before the seed migration runs), the set is empty — the resolver
    // will fall through to defaultEffect (deny-by-default once enforcement is on).
    const principalRoleIdSet = new Set(praRows.map((r) => r.roleId));

    const roles: Role[] = roleRows.map((r) => ({
      id: r.id,
      name: r.name,
      scopeKind: r.scopeKind as "org" | "workspace",
      orgId: r.orgId,
      // Only include the principal if they have an explicit assignment to this
      // role in the principal_role_assignments table (OXA-1498).
      principalIds: principalRoleIdSet.has(r.id) ? [principalRow.id] : [],
    }));

    const roleGrants: RoleGrant[] = roleGrantRows.map((rg) => ({
      roleId: rg.roleId,
      capabilityId: rg.capabilityId,
      effect: rg.effect as "allow" | "deny" | "require_approval",
    }));

    const policies: Policy[] = policyRows;

    return { principal, grants, roles, roleGrants, policies };
  });
}
