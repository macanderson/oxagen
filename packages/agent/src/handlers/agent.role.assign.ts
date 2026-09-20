// agent.role.assign — attach an IAM role to an agent's delegated principal
// (Agent RBAC Phase 1, docs/specs/agent-rbac/spec.md §3.2, §3.4).
//
// Flow:
//   1. Scope guard.
//   2. Role gate — assertOrgRole: org Owner or Admin, the gate the sibling
//      IAM writes (create_role, set_role_grants) run, for the signed-in user
//      or the creator of the API key (resolveActingUserId). That user is the
//      assigner. The kernel's IAM check allows every capability for a
//      non-enterprise org, so the handler checks (INV-29).
// Then, in one tenant-scoped transaction (guards and the write are atomic):
//   3. Resolve the agent (workspace-scoped) and its delegated principal.
//   4. Resolve the role by NAME (seeding is decoupled — spec §3.2).
//   5. Assignability gate: system agent roles only among system roles.
//   6. No tier gate (ADR-069). Custom roles were enterprise-only here, via the
//      same canAccessACL check ADR-063 put on create_role — but ADR-069
//      removed that one and left this one, so on Free, Build and Scale the
//      editor created and edited custom roles that nothing could then bind.
//      An entitlement that stops at the last step is a wall the operator only
//      meets after doing the work. What the tier decides is whether the kernel
//      RESOLVES a grant, which list_iam_roles reports as `enforcement`; it
//      never decided whether a role may exist or be held.
//   7. Delegation ceiling (enterprise): the role's grants may not exceed the
//      assigner's own effective grants — pure-resolver comparison.
//   8. Upsert the principal_role_assignments row (resurrect a soft-deleted
//      row — the partial unique indexes cover soft-deleted rows, so a plain
//      insert after a revoke would conflict and silently no-op).
//   9. Emit the IAM audit event with principal_kind='agent' (fire-and-forget).

import {
  withTenantDb,
  withTransactionOrgScope,
  type Tx,
  schema,
} from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";
import { canAccessACL, resolveOrgTier } from "@oxagen/billing";
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
  if (!ctx.orgId || !ctx.workspaceId) {
    throw new Error("Forbidden: org and workspace scope are required");
  }
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: ["Owner", "Admin"] },
  );
  // assertOrgRole refused a call with no acting user.
  const assignerUserId = actingUserId as string;

  const tier = ctx.planTier ?? (await resolveOrgTier(ctx.orgId));

  const result = await withTenantDb(async (tx) => {
    const agent = await resolveAgentForRoles(
      tx,
      input.agentId,
      ctx.workspaceId,
    );
    if (!agent.principalId) throw new AgentPrincipalMissingError(input.agentId);
    const principalId = agent.principalId;

    const role = await resolveRoleByName(tx, ctx.orgId, input.roleName);

    // System roles: only the agent system roles are agent-assignable — human
    // org roles (Owner is a resolver super-user via rule 7.5) never are.
    if (role.isSystemDefault && !AGENT_SYSTEM_ROLE_NAMES.has(role.name)) {
      throw new AgentRoleNotAssignableError(role.name);
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
          eq(schema.principalRoleAssignments.principalId, principalId),
          eq(schema.principalRoleAssignments.roleId, role.id),
          eq(schema.principalRoleAssignments.orgId, ctx.orgId),
          praWorkspaceId
            ? eq(schema.principalRoleAssignments.workspaceId, praWorkspaceId)
            : isNull(schema.principalRoleAssignments.workspaceId),
        ),
      )
      .limit(1);

    let alreadyAssigned = false;
    const assign = async (tx: Tx) => {
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
            deletedById: null,
            assignedBy: assignerUserId,
            assignedAt: new Date(),
            updatedAt: new Date(),
            updatedById: assignerUserId,
          })
          .where(eq(schema.principalRoleAssignments.id, existing.id));
      } else {
        await tx
          .insert(schema.principalRoleAssignments)
          .values({
            principalId,
            roleId: role.id,
            orgId: ctx.orgId,
            workspaceId: praWorkspaceId,
            assignedBy: assignerUserId,
            createdById: assignerUserId,
            updatedById: assignerUserId,
          })
          .onConflictDoNothing();
      }
    };
    if (praWorkspaceId === null) await withTransactionOrgScope(tx, assign);
    else await assign(tx);

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
