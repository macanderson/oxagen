// fetch-authz.ts — fetch IAM authorization data from Postgres (OXA-1390, Phase 3).
//
// Reads the IAM tables (principals, grants, role_grants, roles, policies) for
// a given principal/scope, so the pure resolver can decide without any I/O.
//
// FAIL-CLOSED ON MISSING MIGRATION (OXA-2056): if the IAM tables do not exist
// yet (Postgres error 42P01 — "relation does not exist"), this is "IAM
// enforcement is silently disabled" — a critical incident, not a benign dev
// convenience. It is logged LOUDLY at error level (not warn) and the caller
// gets a synthetic fail-closed DENY (see denyAuthz below), never EMPTY_AUTHZ.
// EMPTY_AUTHZ would let the resolver fall through to rule 8 (each contract's
// defaultEffect) — for any capability whose defaultEffect is "allow" that is
// an unnoticed IAM bypass in prod. Previously only the API-key path failed
// closed here; human-session callers silently degraded to defaultEffect. Run
// `pnpm db:migrate` to apply the IAM foundation migration and clear the alert.

import { withTenantDb } from "@oxagen/database";
import { eq, and, inArray, isNull, or, gt, sql } from "drizzle-orm";
import { schema } from "@oxagen/database";
import type { Grant, Role, RoleGrant, Policy } from "@oxagen/oxagen/iam";
import { type ResolvedPrincipal } from "@oxagen/oxagen";
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
 * Sentinel principal id used for a synthetic fail-closed deny — either an
 * API-key caller we cannot yet resolve to a real service principal, or ANY
 * caller when the IAM tables themselves are missing (42P01, OXA-2056).
 * Distinct from the all-zero principal the kernel substitutes so denials are
 * traceable.
 */
const UNRESOLVED_SERVICE_PRINCIPAL_ID = "00000000-0000-0000-0000-0000000000ff";

/**
 * Build a fail-closed AuthzData: a synthetic org-enforced DENY policy for the
 * requested capability. resolve()'s rule 2 (org enforced deny) is a hard stop
 * that overrides defaultEffect, so the request is denied rather than
 * degraded — used in two situations:
 *
 * 1. An API-key-authenticated request whose acting identity we cannot
 *    resolve. API keys authorize AS THEIR CREATOR (api_keys.created_by_user_id)
 *    — see _fetchAuthz. This fires when that resolution fails: the key row is
 *    missing/soft-deleted/scoped to another org, carries no recorded creator,
 *    or the creator has no principal in this org. In those cases we must NOT
 *    return EMPTY_AUTHZ, because the resolver would then fall through to rule
 *    8 (contract defaultEffect): any capability whose defaultEffect is
 *    "allow" would be granted to the key regardless of the enterprise org's
 *    role-grant matrix — an IAM bypass on the machine-to-machine surface
 *    (this resolver path runs only for enterprise orgs; the tier gate in
 *    check-iam.ts bypasses it for everyone else).
 *
 * 2. ANY caller (human session or API key) when the IAM tables are missing
 *    (Postgres 42P01 — migration not applied, OXA-2056). This used to return
 *    EMPTY_AUTHZ for human sessions, silently degrading to defaultEffect —
 *    "IAM enforcement is silently disabled in prod" is a critical incident,
 *    not a benign dev convenience, so it now fails closed exactly like the
 *    unresolved-API-key case.
 *
 * A dedicated service principal per key is the durable model; the
 * creator-inheritance path is the no-migration fix that unblocks API keys on
 * enterprise orgs today.
 */
function denyAuthz(
  orgId: string,
  workspaceId: string,
  capability: string,
): AuthzData {
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
 * invocation. FAILS CLOSED (never EMPTY_AUTHZ) if the IAM tables are absent —
 * see denyAuthz() and the OXA-2056 module comment above.
 */
export async function fetchAuthz(args: FetchAuthzArgs): Promise<AuthzData> {
  try {
    return await _fetchAuthz(args);
  } catch (err) {
    if (isUndefinedTable(err)) {
      // IAM migration not yet applied. This is "IAM enforcement is silently
      // disabled in prod" — an operator-actionable incident, so it is logged
      // LOUDLY at error level (OXA-2056; previously this was a warn that was
      // easy to miss and the request silently degraded to defaultEffect).
      logger.error(
        { err, capability: args.capability, orgId: args.orgId },
        "[iam] SECURITY ALERT: IAM tables not found (Postgres 42P01) — IAM " +
          "enforcement is NOT ACTIVE for this request. Failing closed (deny) " +
          "instead of silently falling back to defaultEffect. Run " +
          "`pnpm db:migrate` to apply the IAM foundation migration and clear " +
          "this alert.",
      );
      // Fail closed for EVERY caller (human session or API key) — never
      // degrade to EMPTY_AUTHZ/defaultEffect on a missing migration. Before
      // OXA-2056 only the API-key branch failed closed here; a human-session
      // request silently ran with defaultEffect while IAM was effectively off.
      return denyAuthz(args.orgId, args.workspaceId, args.capability);
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

  // An API-key request authenticates with no session user (userId null,
  // apiKeyId set). It authorizes AS THE KEY'S CREATOR (see below).
  const isApiKey = !userId && !!apiKeyId;

  // Neither a human session nor an API key — nothing to resolve.
  if (!userId && !apiKeyId) return EMPTY_AUTHZ;

  return withTenantDb(async (tx) => {
    // ── Resolve the EFFECTIVE acting user ─────────────────────────────────────
    // Human session → the session user. API key → the user who CREATED the key
    // (api_keys.created_by_user_id): the key inherits its creator's role grants.
    // This is what lets API keys work on enterprise orgs, which run the full
    // resolver — the prior behaviour fail-closed EVERY API-key call. The key row
    // is org-scoped, so the active tenant scope (the key's own org/workspace,
    // set by the auth middleware) sees it. A missing/soft-deleted/foreign-org
    // key or a key with no recorded creator yields no effective user → fail
    // closed below (never fall through to defaultEffect on the m2m surface).
    let effectiveUserId: string | null = userId;
    if (isApiKey) {
      const keyRows = await tx
        .select({ createdByUserId: schema.apiKeys.createdByUserId })
        .from(schema.apiKeys)
        .where(
          and(
            eq(schema.apiKeys.id, apiKeyId as string),
            eq(schema.apiKeys.orgId, orgId),
            isNull(schema.apiKeys.deletedAt),
          ),
        )
        .limit(1);
      effectiveUserId = keyRows[0]?.createdByUserId ?? null;
      if (!effectiveUserId) return denyAuthz(orgId, workspaceId, capability);
    }

    const principalRows = await tx
      .select({
        id: schema.principals.id,
        kind: schema.principals.kind,
        orgId: schema.principals.orgId,
        workspaceId: schema.principals.workspaceId,
      })
      .from(schema.principals)
      .where(
        and(
          eq(schema.principals.orgId, orgId),
          // Match by the effective user's ID stored in parent_user_id. Scoped
          // to kind='human' — agent principals ALSO carry parentUserId=creator
          // (docs/specs/agent-rbac/spec.md §3.1), so without this filter a
          // user who has created agents would match multiple rows here. The
          // partial unique index principals_org_parent_user_human_uniq makes
          // this at most one row for a human, so LIMIT 1 is deterministic.
          eq(schema.principals.parentUserId, effectiveUserId as string),
          eq(schema.principals.kind, "human"),
        ),
      )
      .limit(1);

    const principalRow = principalRows[0];
    if (!principalRow) {
      // The effective user has no principal in this org. For an API key this
      // MUST fail closed (do not degrade to defaultEffect, which would bypass
      // enterprise role grants). For a human session, fall through to
      // defaultEffect via EMPTY_AUTHZ as before.
      return isApiKey ? denyAuthz(orgId, workspaceId, capability) : EMPTY_AUTHZ;
    }

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
      // Carry the system-default flag so the resolver can identify the genuine
      // org Owner role (rule 7.5 — org owner super-user). A user-created role
      // named "Owner" has is_system_default = false and does NOT qualify.
      isSystemDefault: r.isSystemDefault,
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
