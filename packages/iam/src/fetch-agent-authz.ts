// fetch-agent-authz.ts — fetch the once-per-run IAM snapshot for an agent run
// (Agent RBAC Phase 2, docs/specs/agent-rbac/spec.md §3.4/§3.5).
//
// Unlike fetch-authz.ts (one principal, one capability), this loads the authz
// data for BOTH principals of the delegation ceiling (agent + invoking human)
// across ALL capabilities: the snapshot is computed once per run, cached on
// the run context (AgentRunIAMContext.resolution — see
// packages/oxagen/src/iam/agent-run.ts), and must serve every capability the
// run may touch — kernel invoke() checks and the tool-materialization
// allowlist read the same object.
//
// FAIL-CLOSED ON MISSING MIGRATION (same OXA-2056 posture as fetch-authz.ts,
// different mechanism): if the IAM tables are absent (Postgres 42P01) this
// THROWS after logging loudly. The kernel's IAM seam treats a check-fn throw
// as an evaluation failure and fails closed unconditionally (authz_denied,
// independent of IAM_ENFORCEMENT_ENABLED) — an agent run without IAM tables
// can execute nothing, which is the correct posture for an unattended
// automation. fetch-authz.ts instead synthesizes a per-capability deny
// policy, which cannot express "deny everything" for an all-capability
// snapshot — hence the throw here.

import { withTenantDb } from "@oxagen/database";
import { eq, and, inArray, isNull, or, gt, sql } from "drizzle-orm";
import { schema } from "@oxagen/database";
import type {
  AgentAuthzSnapshot,
  Grant,
  Policy,
  Role,
  RoleGrant,
} from "@oxagen/oxagen/iam";
import { logger } from "./logger";

/**
 * Postgres error code for "relation does not exist" — IAM migration not
 * applied. Mirrors fetch-authz.ts.
 */
const PG_UNDEFINED_TABLE = "42P01";

function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<string, unknown>)["code"] === PG_UNDEFINED_TABLE
  );
}

export interface FetchAgentRunAuthzArgs {
  orgId: string;
  workspaceId: string;
  /** The agent's own delegated principal id (iam.principals, kind='agent'). */
  agentPrincipalId: string;
  /**
   * The invoking human's principal id, or null when the run carries no
   * resolvable delegator (the resolver then uses the unprivileged sentinel —
   * see SENTINEL_PRINCIPAL_ID in @oxagen/oxagen/iam).
   */
  humanPrincipalId: string | null;
}

/**
 * Load the full authz snapshot for one agent run: every role in the org, the
 * live role memberships of both delegation-ceiling principals, and every
 * role-grant of those roles (all capabilities). Direct grants and policies
 * tables were dropped in migration 0027 (see fetch-authz.ts) — role-based
 * evaluation only, so both come back empty.
 */
export async function fetchAgentRunAuthz(
  args: FetchAgentRunAuthzArgs,
): Promise<AgentAuthzSnapshot> {
  try {
    return await _fetchAgentRunAuthz(args);
  } catch (err) {
    if (isUndefinedTable(err)) {
      logger.error(
        { err, orgId: args.orgId, agentPrincipalId: args.agentPrincipalId },
        "[iam] SECURITY ALERT: IAM tables not found (Postgres 42P01) while " +
          "resolving an AGENT run's authz snapshot — failing closed (the " +
          "kernel denies every capability for this run). Run `pnpm db:migrate` " +
          "to apply the IAM foundation migration and clear this alert.",
      );
    }
    // Propagate — the kernel's IAM seam fails closed on a check-fn throw
    // (unconditional authz_denied, OXA-2056 semantics).
    throw err;
  }
}

async function _fetchAgentRunAuthz(
  args: FetchAgentRunAuthzArgs,
): Promise<AgentAuthzSnapshot> {
  const { orgId, workspaceId, agentPrincipalId, humanPrincipalId } = args;

  const principalIds = [
    agentPrincipalId,
    ...(humanPrincipalId !== null ? [humanPrincipalId] : []),
  ];

  return withTenantDb(async (tx) => {
    // Query 1 — every role in the org (both principals' memberships and the
    // grant rows below key off these ids).
    const roleRows = await tx
      .select()
      .from(schema.roles)
      .where(eq(schema.roles.orgId, orgId));

    const roleIds = roleRows.map((r) => r.id);

    // Query 2a — role_grants for ALL capabilities of these roles (the per-run
    // snapshot serves the whole capability registry — no capability filter).
    // Query 2b — live role assignments for BOTH principals, honouring the
    // same soft-delete / JIT-expiry / workspace-scope predicates as
    // fetch-authz.ts (a workspace-scoped assignment must not leak org-wide).
    const [roleGrantRows, praRows] = await Promise.all([
      roleIds.length > 0
        ? tx
            .select()
            .from(schema.roleGrants)
            .where(inArray(schema.roleGrants.roleId, roleIds))
        : Promise.resolve([] as (typeof schema.roleGrants.$inferSelect)[]),
      tx
        .select({
          roleId: schema.principalRoleAssignments.roleId,
          principalId: schema.principalRoleAssignments.principalId,
        })
        .from(schema.principalRoleAssignments)
        .where(
          and(
            inArray(schema.principalRoleAssignments.principalId, principalIds),
            eq(schema.principalRoleAssignments.orgId, orgId),
            isNull(schema.principalRoleAssignments.deletedAt),
            or(
              isNull(schema.principalRoleAssignments.expiresAt),
              gt(schema.principalRoleAssignments.expiresAt, sql`now()`),
            ),
            or(
              isNull(schema.principalRoleAssignments.workspaceId),
              eq(schema.principalRoleAssignments.workspaceId, workspaceId),
            ),
          ),
        ),
    ]);

    // role id → the (subset of our two) principals assigned to it. The pure
    // resolver reads membership off Role.principalIds, so each role carries
    // exactly the ceiling principals that hold it.
    const membersByRole = new Map<string, string[]>();
    for (const pra of praRows) {
      const members = membersByRole.get(pra.roleId) ?? [];
      if (!members.includes(pra.principalId)) members.push(pra.principalId);
      membersByRole.set(pra.roleId, members);
    }

    const roles: Role[] = roleRows.map((r) => ({
      id: r.id,
      name: r.name,
      scopeKind: r.scopeKind as "org" | "workspace",
      orgId: r.orgId,
      isSystemDefault: r.isSystemDefault,
      principalIds: membersByRole.get(r.id) ?? [],
    }));

    const roleGrants: RoleGrant[] = roleGrantRows.map((rg) => ({
      roleId: rg.roleId,
      capabilityId: rg.capabilityId,
      effect: rg.effect as RoleGrant["effect"],
      // Agent RBAC resourceScope ceiling rides on role_grants.conditions_jsonb
      // (spec §3.3). Read defensively: the column lands with the seeder-side
      // migration (20260806090000_role_grants_conditions_jsonb) and is
      // nullable — absent means "no ceiling beyond the effect".
      conditionsJsonb:
        (rg as { conditionsJsonb?: unknown }).conditionsJsonb ?? undefined,
    }));

    // Direct grants and policies tables were dropped in migration 0027 — see
    // fetch-authz.ts. Role-based evaluation only.
    const grants: Grant[] = [];
    const policies: Policy[] = [];

    return { grants, roles, roleGrants, policies };
  });
}
