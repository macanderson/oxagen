import { withTenantDb, schema } from "@oxagen/database";
import { canAccessACL } from "@oxagen/billing";
import type {
  AgentRoleAssignInput,
  AgentRoleAssignOutput,
} from "@oxagen/oxagen/contracts/agent.role.assign";
import type { CapabilityContext } from "../types";
import { and, eq, isNull } from "drizzle-orm";
import { resolveAgent } from "./_agent-definition";
import {
  resolveAssignerEffectiveGrants,
  targetRoleExceedsAssignerGrants,
} from "./_agent-role";

export type { AgentRoleAssignInput, AgentRoleAssignOutput };

/**
 * agent.role.assign handler — replace an agent's role assignment.
 *
 * Delegation ceiling (spec §3.1): rejects when the target role's ALLOW
 * grants exceed the assigning human's own effective grants.
 * Tier gating (spec §3.4): CUSTOM agent roles (isSystemDefault=false)
 * require an enterprise org — the three system roles are assignable
 * everywhere.
 */
export async function agentRoleAssignHandler(
  input: AgentRoleAssignInput,
  ctx: CapabilityContext,
): Promise<AgentRoleAssignOutput> {
  if (!ctx.userId) {
    throw new Error("agent.role.assign requires an authenticated user");
  }
  const userId = ctx.userId;

  return withTenantDb(async (tx) => {
    const agent = await resolveAgent(input.agentId, ctx.workspaceId, tx);
    if (!agent) throw new Error(`Agent "${input.agentId}" not found`);
    if (!agent.principalId) {
      throw new Error(
        `Agent "${input.agentId}" has no IAM principal — cannot assign a role`,
      );
    }

    const [roleRow] = await tx
      .select({
        id: schema.roles.id,
        name: schema.roles.name,
        isSystemDefault: schema.roles.isSystemDefault,
      })
      .from(schema.roles)
      .where(
        and(
          eq(schema.roles.orgId, ctx.orgId),
          eq(schema.roles.publicId, input.roleId),
        ),
      )
      .limit(1);
    if (!roleRow)
      throw new Error(`Role "${input.roleId}" not found in this org`);

    // ── Tier gating (spec §3.4): custom agent roles are enterprise-only ──────
    if (!roleRow.isSystemDefault) {
      const tier = ctx.planTier ?? "free";
      if (!canAccessACL(tier)) {
        throw new Error(
          `Custom agent roles require an enterprise plan (org tier: ${tier}). System agent roles (Agent Observer/Contributor/Operator) remain assignable at every tier.`,
        );
      }
    }

    // ── Delegation ceiling (spec §3.1) ───────────────────────────────────────
    const assignerGrants = await resolveAssignerEffectiveGrants(
      tx,
      ctx.orgId,
      userId,
    );
    const ceiling = await targetRoleExceedsAssignerGrants(
      tx,
      roleRow.id,
      assignerGrants,
    );
    if (ceiling.exceeds) {
      throw new Error(
        `Cannot assign role "${roleRow.name}": it grants "${ceiling.capability}", which exceeds your own effective grants (delegation ceiling).`,
      );
    }

    // ── Find + soft-delete any existing assignment for this agent principal ──
    const [existing] = await tx
      .select({
        id: schema.principalRoleAssignments.id,
        roleId: schema.roles.publicId,
      })
      .from(schema.principalRoleAssignments)
      .innerJoin(
        schema.roles,
        eq(schema.roles.id, schema.principalRoleAssignments.roleId),
      )
      .where(
        and(
          eq(schema.principalRoleAssignments.principalId, agent.principalId),
          eq(schema.principalRoleAssignments.orgId, ctx.orgId),
          isNull(schema.principalRoleAssignments.deletedAt),
        ),
      )
      .limit(1);

    if (existing) {
      await tx
        .update(schema.principalRoleAssignments)
        .set({
          deletedAt: new Date(),
          deletedByUserId: userId,
          updatedAt: new Date(),
          updatedByUserId: userId,
        })
        .where(eq(schema.principalRoleAssignments.id, existing.id));
    }

    const [assignment] = await tx
      .insert(schema.principalRoleAssignments)
      .values({
        principalId: agent.principalId,
        roleId: roleRow.id,
        orgId: ctx.orgId,
        workspaceId: input.workspaceId ?? null,
        assignedBy: userId,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .returning({ publicId: schema.principalRoleAssignments.publicId });
    if (!assignment)
      throw new Error("principal_role_assignments insert failed");

    return {
      assignmentId: assignment.publicId,
      agentId: agent.publicId,
      roleId: input.roleId,
      roleName: roleRow.name,
      previousRoleId: existing?.roleId ?? null,
    };
  });
}
