// agent.role.assign — attach an IAM role to an agent's delegated principal
// (Agent RBAC Phase 1, docs/specs/agent-rbac/spec.md §3.2, §3.4).
//
// Flow (single tenant-scoped transaction — guards and the write are atomic):
//   1. Auth + scope guard.
//   2. Resolve the effective assigner (session user, or API key creator).
//   3. Resolve the agent (workspace-scoped) and its delegated principal.
//   4. Resolve the role by NAME (seeding is decoupled — spec §3.2).
//   5. Assignability gate: system agent roles only among system roles.
//   6. Tier gate (§3.4): custom roles are enterprise-only (canAccessACL —
//      the same check that gates custom IAM ACL); system agent roles are
//      assignable at every tier.
//   7. Delegation ceiling (enterprise): the role's grants may not exceed the
//      assigner's own effective grants — pure-resolver comparison.
//   8. Upsert the principal_role_assignments row (resurrect a soft-deleted
//      row — the partial unique indexes cover soft-deleted rows, so a plain
//      insert after a revoke would conflict and silently no-op).
//   9. Emit the IAM audit event with principal_kind='agent' (fire-and-forget).

import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";
import { canAccessACL, resolveOrgTier, TierDeniedError } from "@oxagen/billing";
import { agentRoleAssign } from "@oxagen/oxagen/contracts/agent.role.assign";
import type {
  AgentRoleAssignInput,
  AgentRoleAssignOutput,
} from "@oxagen/oxagen/contracts/agent.role.assign";
import type { CapabilityContext } from "../types";
import {
  AGENT_SYSTEM_ROLE_NAMES,
  AgentPrincipalMissingError,
  AgentRoleNotAssignableError,
  assertWithinDelegationCeiling,
  emitAgentRoleAudit,
  resolveAgentForRoles,
  resolveEffectiveAssigner,
  resolveRoleByName,
} from "./_agent-role";

export type { AgentRoleAssignInput, AgentRoleAssignOutput };

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.role" },
});

export async function agentRoleAssignHandler(
  input: AgentRoleAssignInput,
  ctx: CapabilityContext,
): Promise<AgentRoleAssignOutput> {
  if (!ctx.userId && !ctx.apiKeyId) {
    throw new Error("Unauthorized: no authenticated principal");
  }
  if (!ctx.orgId || !ctx.workspaceId) {
    throw new Error("Forbidden: org and workspace scope are required");
  }

  const tier = ctx.planTier ?? (await resolveOrgTier(ctx.orgId));

  const result = await withTenantDb(async (tx) => {
    const assignerUserId = await resolveEffectiveAssigner(tx, ctx);

    const agent = await resolveAgentForRoles(
      tx,
      input.agentId,
      ctx.workspaceId,
    );
    if (!agent.principalId) throw new AgentPrincipalMissingError(input.agentId);

    const role = await resolveRoleByName(tx, ctx.orgId, input.roleName);

    // System roles: only the agent system roles are agent-assignable — human
    // org roles (Owner is a resolver super-user via rule 7.5) never are.
    if (role.isSystemDefault && !AGENT_SYSTEM_ROLE_NAMES.has(role.name)) {
      throw new AgentRoleNotAssignableError(role.name);
    }

    // Tier gate (§3.4): system agent roles at every tier; custom roles are
    // enterprise-only — the same canAccessACL check that gates custom IAM ACL.
    if (!role.isSystemDefault && !canAccessACL(tier)) {
      throw new TierDeniedError(tier, "enterprise", "custom agent roles");
    }

    // Delegation ceiling. Enterprise orgs run the full pure-resolver
    // comparison; for non-enterprise tiers checkIAM's fast-path resolves the
    // human assigner to an unconditional allow for every capability, so the
    // ceiling is vacuously satisfied and the comparison is skipped (mirrors
    // packages/iam/check-iam.ts, not a new policy).
    if (canAccessACL(tier)) {
      await assertWithinDelegationCeiling(tx, {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        userId: assignerUserId,
        roleId: role.id,
        roleName: role.name,
      });
    }

    // Workspace-scoped roles bind to the current workspace; org-scoped roles
    // are org-wide (principal_role_assignments.workspace_id NULL).
    const praWorkspaceId =
      role.scopeKind === "workspace" ? ctx.workspaceId : null;

    const [existing] = await tx
      .select({
        id: schema.principalRoleAssignments.id,
        deletedAt: schema.principalRoleAssignments.deletedAt,
      })
      .from(schema.principalRoleAssignments)
      .where(
        and(
          eq(schema.principalRoleAssignments.principalId, agent.principalId),
          eq(schema.principalRoleAssignments.roleId, role.id),
          eq(schema.principalRoleAssignments.orgId, ctx.orgId),
          praWorkspaceId
            ? eq(schema.principalRoleAssignments.workspaceId, praWorkspaceId)
            : isNull(schema.principalRoleAssignments.workspaceId),
        ),
      )
      .limit(1);

    let alreadyAssigned = false;
    if (existing && existing.deletedAt === null) {
      alreadyAssigned = true;
    } else if (existing) {
      // Resurrect the soft-deleted row: the partial unique indexes on
      // (principal, role, org[, workspace]) include soft-deleted rows, so a
      // fresh insert would conflict and silently no-op after a revoke.
      await tx
        .update(schema.principalRoleAssignments)
        .set({
          deletedAt: null,
          deletedByUserId: null,
          assignedBy: assignerUserId,
          assignedAt: new Date(),
          updatedAt: new Date(),
          updatedByUserId: assignerUserId,
        })
        .where(eq(schema.principalRoleAssignments.id, existing.id));
    } else {
      await tx
        .insert(schema.principalRoleAssignments)
        .values({
          principalId: agent.principalId,
          roleId: role.id,
          orgId: ctx.orgId,
          workspaceId: praWorkspaceId,
          assignedBy: assignerUserId,
          createdByUserId: assignerUserId,
          updatedByUserId: assignerUserId,
        })
        .onConflictDoNothing();
    }

    return {
      agent,
      role,
      assignerUserId,
      alreadyAssigned,
    };
  });

  if (!result.alreadyAssigned) {
    emitAgentRoleAudit({
      capability: agentRoleAssign.name,
      ctx,
      agentPrincipalId: result.agent.principalId as string,
      agentPublicId: result.agent.publicId,
      roleName: result.role.name,
      action: "assigned",
      actorUserId: result.assignerUserId,
      rawInputJson: JSON.stringify(input),
    });
  }

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      agentId: result.agent.publicId,
      roleName: result.role.name,
      alreadyAssigned: result.alreadyAssigned,
      surface: ctx.surface,
    },
    "agent.role.assign: role assignment resolved",
  );

  return {
    assigned: true,
    alreadyAssigned: result.alreadyAssigned,
    agentId: result.agent.publicId,
    roleId: result.role.publicId,
    roleName: result.role.name,
  };
}
