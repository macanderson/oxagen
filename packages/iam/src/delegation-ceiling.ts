// delegation-ceiling.ts — a granter cannot hand out more than they hold.
//
// The one implementation of the rule the mockup states on every role
// screen and ADR-063 records: a role about to be attached to an agent
// (`assign_agent_role`) or written by the role editor (`create_role`,
// `set_role_grants`) may not confer, for any capability, an outcome less
// restrictive than the granting user's own. The granter is resolved per
// capability through the pure IAM resolver (packages/oxagen/src/iam/
// resolve.ts) with their own roles and assignments — the same evaluation the
// kernel runs for them — so the system org Owner passes by rule 7.5 and a
// user with no principal falls through to each contract's default effect.
//
// The reads are a small interface so the rule is tested without a database
// and both callers bind the same Postgres implementation inside their own
// transaction: the check and the write are one atomic, RLS-scoped unit.

import { schema, type Tx } from "@oxagen/database";
import {
  resolve,
  type Grant,
  type Policy,
  type Role,
  type RoleGrant,
} from "@oxagen/oxagen/iam";
import { getCapability } from "@oxagen/oxagen/registry";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

export interface ConferredGrant {
  readonly capabilityId: string;
  readonly effect: "allow" | "deny" | "require_approval";
}

/** The four reads the rule needs, in the caller's transaction. */
export interface DelegationCeilingReads {
  /** The granter's active human principal in the org, or null. */
  assignerPrincipalId(orgId: string, userId: string): Promise<string | null>;
  /** Every role of the org, as the resolver models them (memberships filled in by the caller). */
  orgRoles(
    orgId: string,
  ): Promise<
    Array<Pick<Role, "id" | "name" | "scopeKind" | "orgId" | "isSystemDefault">>
  >;
  /** The granter's unexpired assignments: org-wide, or on `workspaceId`. */
  assignerRoleIds(
    principalId: string,
    orgId: string,
    workspaceId: string,
  ): Promise<string[]>;
  /** The grants of `roleIds` on `capabilityIds`. */
  roleGrantsOn(
    roleIds: readonly string[],
    capabilityIds: readonly string[],
  ): Promise<RoleGrant[]>;
}

export function postgresDelegationCeilingReads(tx: Tx): DelegationCeilingReads {
  return {
    async assignerPrincipalId(orgId, userId) {
      const [row] = await tx
        .select({ id: schema.principals.id })
        .from(schema.principals)
        .where(
          and(
            eq(schema.principals.orgId, orgId),
            eq(schema.principals.parentUserId, userId),
            eq(schema.principals.kind, "human"),
          ),
        )
        .limit(1);
      return row?.id ?? null;
    },
    orgRoles(orgId) {
      return tx
        .select({
          id: schema.roles.id,
          name: schema.roles.name,
          scopeKind: schema.roles.scopeKind,
          orgId: schema.roles.orgId,
          isSystemDefault: schema.roles.isSystemDefault,
        })
        .from(schema.roles)
        .where(eq(schema.roles.orgId, orgId))
        .then((rows) =>
          rows.map((r) => ({
            ...r,
            scopeKind: r.scopeKind as Role["scopeKind"],
          })),
        );
    },
    async assignerRoleIds(principalId, orgId, workspaceId) {
      const rows = await tx
        .select({ roleId: schema.principalRoleAssignments.roleId })
        .from(schema.principalRoleAssignments)
        .where(
          and(
            eq(schema.principalRoleAssignments.principalId, principalId),
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
        );
      return rows.map((r) => r.roleId);
    },
    async roleGrantsOn(roleIds, capabilityIds) {
      if (roleIds.length === 0 || capabilityIds.length === 0) return [];
      const rows = await tx
        .select({
          roleId: schema.roleGrants.roleId,
          capabilityId: schema.roleGrants.capabilityId,
          effect: schema.roleGrants.effect,
        })
        .from(schema.roleGrants)
        .where(
          and(
            inArray(schema.roleGrants.roleId, [...roleIds]),
            inArray(schema.roleGrants.capabilityId, [...capabilityIds]),
          ),
        );
      return rows.map((rg) => ({
        roleId: rg.roleId,
        capabilityId: rg.capabilityId,
        effect: rg.effect as RoleGrant["effect"],
      }));
    },
  };
}

/**
 * Outcome restrictiveness rank (mirrors the deny-wins merge in resolve.ts):
 * a grant exceeds the ceiling when it confers a strictly less restrictive
 * outcome than the granter's own resolution.
 */
const OUTCOME_RANK: Record<"allow" | "pending_approval" | "deny", number> = {
  allow: 0,
  pending_approval: 1,
  deny: 2,
};

const NO_PRINCIPAL = "00000000-0000-0000-0000-000000000000";

/**
 * The capabilities in `conferred` the granter may not hand out: each is
 * resolved for the granter and compared by restrictiveness. `deny` grants
 * never widen anything and are skipped. An unknown capability (a stale grant
 * naming a since-removed contract) fails closed to a `deny` default. Empty
 * when the set is within the ceiling.
 */
export async function findDelegationCeilingViolations(
  reads: DelegationCeilingReads,
  args: {
    orgId: string;
    workspaceId: string;
    /** The effective granting user (the session user, or an API key's creator). */
    userId: string;
    conferred: readonly ConferredGrant[];
    now?: Date;
  },
): Promise<string[]> {
  const { orgId, workspaceId, userId } = args;
  const now = args.now ?? new Date();

  const conferring = args.conferred.filter((g) => g.effect !== "deny");
  if (conferring.length === 0) return [];
  const capabilityIds = [...new Set(conferring.map((g) => g.capabilityId))];

  const principalId = await reads.assignerPrincipalId(orgId, userId);
  const assignerPrincipalId = principalId ?? NO_PRINCIPAL;
  const roleRows = await reads.orgRoles(orgId);
  const memberRoleIds = new Set(
    principalId
      ? await reads.assignerRoleIds(principalId, orgId, workspaceId)
      : [],
  );
  const roles: Role[] = roleRows.map((r) => ({
    ...r,
    principalIds: memberRoleIds.has(r.id) ? [assignerPrincipalId] : [],
  }));
  const roleGrants = await reads.roleGrantsOn(
    roleRows.map((r) => r.id),
    capabilityIds,
  );

  // Direct grants and policies were dropped in migration 0027 (see
  // fetch-authz.ts) — role-based evaluation only.
  const grants: Grant[] = [];
  const policies: Policy[] = [];

  const violations = new Set<string>();
  for (const grant of conferring) {
    const conferredOutcome =
      grant.effect === "allow" ? "allow" : "pending_approval";
    const assigner = resolve({
      principal: { id: assignerPrincipalId, kind: "human", orgId, workspaceId },
      capability: grant.capabilityId,
      scope: { kind: "workspace", orgId, workspaceId },
      grants,
      roles,
      roleGrants,
      policies,
      defaultEffect: getCapability(grant.capabilityId)?.defaultEffect ?? "deny",
      now,
    });
    if (OUTCOME_RANK[conferredOutcome] < OUTCOME_RANK[assigner.outcome]) {
      violations.add(grant.capabilityId);
    }
  }
  return [...violations];
}
