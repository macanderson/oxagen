// agent.role.revoke — detach an IAM role from an agent's delegated principal
// (Agent RBAC Phase 1, docs/specs/agent-rbac/spec.md §3.2).
//
// Soft-deletes the active principal_role_assignments row (audit trail
// preserved; agent.role.assign resurrects it on re-assign). Revocation is
// pure narrowing, so it carries no tier gate and no delegation-ceiling check.
// Idempotent: revoking an unheld role returns revoked=false.

import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";
import { agentRoleRevoke } from "@oxagen/oxagen/contracts/agent.role.revoke";
import type {
  AgentRoleRevokeInput,
  AgentRoleRevokeOutput,
} from "@oxagen/oxagen/contracts/agent.role.revoke";
import type { CapabilityContext } from "../types";
import {
  AgentPrincipalMissingError,
  emitAgentRoleAudit,
  resolveAgentForRoles,
  resolveEffectiveAssigner,
  resolveRoleByName,
} from "./_agent-role";

export type { AgentRoleRevokeInput, AgentRoleRevokeOutput };

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.role" },
});

export async function agentRoleRevokeHandler(
  input: AgentRoleRevokeInput,
  ctx: CapabilityContext,
): Promise<AgentRoleRevokeOutput> {
  if (!ctx.userId && !ctx.apiKeyId) {
    throw new Error("Unauthorized: no authenticated principal");
  }
  if (!ctx.orgId || !ctx.workspaceId) {
    throw new Error("Forbidden: org and workspace scope are required");
  }

  const result = await withTenantDb(async (tx) => {
    const actorUserId = await resolveEffectiveAssigner(tx, ctx);

    const agent = await resolveAgentForRoles(
      tx,
      input.agentId,
      ctx.workspaceId,
    );
    if (!agent.principalId) throw new AgentPrincipalMissingError(input.agentId);

    const role = await resolveRoleByName(tx, ctx.orgId, input.roleName);

    const revokedRows = await tx
      .update(schema.principalRoleAssignments)
      .set({
        deletedAt: new Date(),
        deletedByUserId: actorUserId,
        updatedAt: new Date(),
        updatedByUserId: actorUserId,
      })
      .where(
        and(
          eq(schema.principalRoleAssignments.principalId, agent.principalId),
          eq(schema.principalRoleAssignments.roleId, role.id),
          eq(schema.principalRoleAssignments.orgId, ctx.orgId),
          isNull(schema.principalRoleAssignments.deletedAt),
        ),
      )
      .returning({ id: schema.principalRoleAssignments.id });

    return { agent, role, actorUserId, revoked: revokedRows.length > 0 };
  });

  if (result.revoked) {
    emitAgentRoleAudit({
      capability: agentRoleRevoke.name,
      ctx,
      agentPrincipalId: result.agent.principalId as string,
      agentPublicId: result.agent.publicId,
      roleName: result.role.name,
      action: "revoked",
      actorUserId: result.actorUserId,
      rawInputJson: JSON.stringify(input),
    });
  }

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      agentId: result.agent.publicId,
      roleName: result.role.name,
      revoked: result.revoked,
      surface: ctx.surface,
    },
    "agent.role.revoke: role revocation resolved",
  );

  return {
    revoked: result.revoked,
    agentId: result.agent.publicId,
    roleName: result.role.name,
  };
}
