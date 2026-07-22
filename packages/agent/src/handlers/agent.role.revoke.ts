import { withTenantDb, schema } from "@oxagen/database";
import type {
  AgentRoleRevokeInput,
  AgentRoleRevokeOutput,
} from "@oxagen/oxagen/contracts/agent.role.revoke";
import type { CapabilityContext } from "../types";
import { and, eq, isNull } from "drizzle-orm";
import { resolveAgent } from "./_agent-definition";

export type { AgentRoleRevokeInput, AgentRoleRevokeOutput };

/**
 * agent.role.revoke handler — soft-delete an agent's role assignment.
 */
export async function agentRoleRevokeHandler(
  input: AgentRoleRevokeInput,
  ctx: CapabilityContext,
): Promise<AgentRoleRevokeOutput> {
  if (!ctx.userId) {
    throw new Error("agent.role.revoke requires an authenticated user");
  }
  const userId = ctx.userId;

  return withTenantDb(async (tx) => {
    const agent = await resolveAgent(input.agentId, ctx.workspaceId, tx);
    if (!agent) throw new Error(`Agent "${input.agentId}" not found`);
    if (!agent.principalId) {
      throw new Error(`Agent "${input.agentId}" has no IAM principal`);
    }

    const [roleRow] = await tx
      .select({ id: schema.roles.id })
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

    const result = await tx
      .update(schema.principalRoleAssignments)
      .set({
        deletedAt: new Date(),
        deletedByUserId: userId,
        updatedAt: new Date(),
        updatedByUserId: userId,
      })
      .where(
        and(
          eq(schema.principalRoleAssignments.principalId, agent.principalId),
          eq(schema.principalRoleAssignments.roleId, roleRow.id),
          eq(schema.principalRoleAssignments.orgId, ctx.orgId),
          isNull(schema.principalRoleAssignments.deletedAt),
        ),
      )
      .returning({ id: schema.principalRoleAssignments.id });

    return {
      revoked: result.length > 0,
      agentId: agent.publicId,
      roleId: input.roleId,
    };
  });
}
