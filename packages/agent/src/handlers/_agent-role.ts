// _agent-role.ts — shared helpers for the agent.role.assign/.revoke/.list/.get
// handlers (docs/specs/agent-rbac/spec.md Phase 1).
//
// Delegation ceiling: the assigning principal cannot attach a role whose
// grants exceed their OWN effective grants. We approximate "effective
// grants" as the union, across every role the assigner holds (org-wide or
// workspace-scoped), of the STRONGEST effect per capability — deny beats
// require_approval beats allow, mirroring the resolver's own precedence so
// this ceiling check stays consistent with runtime enforcement. The org
// Owner is treated as holding every capability (super-user, resolver rule
// 7.5) so an Owner can always assign any role.

import { schema, type Tx } from "@oxagen/database";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { ORG_OWNER_ROLE_NAME } from "@oxagen/oxagen/iam";

export type GrantEffectRank = 0 | 1 | 2; // allow < require_approval < deny

const EFFECT_RANK: Record<string, GrantEffectRank> = {
  allow: 0,
  require_approval: 1,
  deny: 2,
};

/**
 * Effective per-capability effect map for a principal: the strongest effect
 * across every (org-wide or workspace-scoped) role they currently hold.
 * Returns `null` sentinel via the isOwner flag when the principal holds the
 * system-default Owner role — that principal's ceiling is "everything".
 */
export interface EffectiveGrants {
  isOwner: boolean;
  byCapability: Map<string, string>; // capability -> strongest effect
}

/**
 * Resolve the effective grants of a HUMAN principal (by userId) within an
 * org, for use as the delegation ceiling when that human assigns a role to
 * an agent. Must run inside the same transaction as the assignment write so
 * a concurrent role change of the assigner cannot race the check (TOCTOU).
 */
export async function resolveAssignerEffectiveGrants(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<EffectiveGrants> {
  const [principalRow] = await tx
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

  if (!principalRow) return { isOwner: false, byCapability: new Map() };

  const roleRows = await tx
    .select({
      roleId: schema.roles.id,
      roleName: schema.roles.name,
      isSystemDefault: schema.roles.isSystemDefault,
    })
    .from(schema.principalRoleAssignments)
    .innerJoin(
      schema.roles,
      eq(schema.roles.id, schema.principalRoleAssignments.roleId),
    )
    .where(
      and(
        eq(schema.principalRoleAssignments.principalId, principalRow.id),
        eq(schema.principalRoleAssignments.orgId, orgId),
        isNull(schema.principalRoleAssignments.deletedAt),
        // Exclude expired JIT assignments (expires_at in the past). A NULL
        // expires_at means a permanent (non-JIT) assignment. Mirrors the
        // resolver's PRA query (fetch-authz.ts) so the delegation ceiling
        // stays consistent with runtime enforcement — an expired elevated
        // role must not inflate the assigner's effective grants.
        or(
          isNull(schema.principalRoleAssignments.expiresAt),
          gt(schema.principalRoleAssignments.expiresAt, sql`now()`),
        ),
      ),
    );

  const isOwner = roleRows.some(
    (r) => r.roleName === ORG_OWNER_ROLE_NAME && r.isSystemDefault,
  );
  if (isOwner) return { isOwner: true, byCapability: new Map() };

  const roleIds = roleRows.map((r) => r.roleId);
  const byCapability = new Map<string, string>();
  if (roleIds.length > 0) {
    const grantRows = await tx
      .select({
        capabilityId: schema.roleGrants.capabilityId,
        effect: schema.roleGrants.effect,
      })
      .from(schema.roleGrants)
      .where(or(...roleIds.map((id) => eq(schema.roleGrants.roleId, id))));
    for (const g of grantRows) {
      const existing = byCapability.get(g.capabilityId);
      const existingRank = existing ? (EFFECT_RANK[existing] ?? 0) : -1;
      const newRank = EFFECT_RANK[g.effect] ?? 0;
      if (newRank > existingRank) byCapability.set(g.capabilityId, g.effect);
    }
  }
  return { isOwner: false, byCapability };
}

/**
 * True when `targetRoleId`'s grants exceed `assigner`'s effective grants —
 * i.e. the target role ALLOWs a capability the assigner does not themselves
 * effectively allow. An Owner assigner never exceeds (isOwner short-circuit).
 */
export async function targetRoleExceedsAssignerGrants(
  tx: Tx,
  targetRoleId: string,
  assigner: EffectiveGrants,
): Promise<{ exceeds: boolean; capability?: string }> {
  if (assigner.isOwner) return { exceeds: false };

  const targetGrants = await tx
    .select({
      capabilityId: schema.roleGrants.capabilityId,
      effect: schema.roleGrants.effect,
    })
    .from(schema.roleGrants)
    .where(eq(schema.roleGrants.roleId, targetRoleId));

  for (const g of targetGrants) {
    if (g.effect !== "allow") continue; // only ALLOW grants extend power
    const assignerEffect = assigner.byCapability.get(g.capabilityId);
    if (assignerEffect !== "allow") {
      return { exceeds: true, capability: g.capabilityId };
    }
  }
  return { exceeds: false };
}
