import { withTenantDb, schema } from "@oxagen/database";
import type {
  AgentRoleGetInput,
  AgentRoleGetOutput,
} from "@oxagen/oxagen/contracts/agent.role.get";
import type { CapabilityContext } from "../types";
import { and, eq, isNull, or, gt } from "drizzle-orm";
import { resolveAgent } from "./_agent-definition";

export type { AgentRoleGetInput, AgentRoleGetOutput };

/**
 * agent.role.get handler — read one (agentId, roleId) assignment. Returns
 * `assignment: null` (never throws) when the agent does not hold that role.
 */
export async function agentRoleGetHandler(
  input: AgentRoleGetInput,
  ctx: CapabilityContext,
): Promise<AgentRoleGetOutput> {
  return withTenantDb(async (tx) => {
    const agent = await resolveAgent(input.agentId, ctx.workspaceId, tx);
    if (!agent) throw new Error(`Agent "${input.agentId}" not found`);
    if (!agent.principalId)
      return { agentId: agent.publicId, assignment: null };

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
    if (!roleRow) return { agentId: agent.publicId, assignment: null };

    const now = new Date();
    const [row] = await tx
      .select({
        assignmentId: schema.principalRoleAssignments.publicId,
        roleId: schema.roles.publicId,
        roleName: schema.roles.name,
        isSystemDefault: schema.roles.isSystemDefault,
        workspaceId: schema.principalRoleAssignments.workspaceId,
        assignedAt: schema.principalRoleAssignments.assignedAt,
        expiresAt: schema.principalRoleAssignments.expiresAt,
      })
      .from(schema.principalRoleAssignments)
      .innerJoin(
        schema.roles,
        eq(schema.roles.id, schema.principalRoleAssignments.roleId),
      )
      .where(
        and(
          eq(schema.principalRoleAssignments.principalId, agent.principalId),
          eq(schema.principalRoleAssignments.roleId, roleRow.id),
          eq(schema.principalRoleAssignments.orgId, ctx.orgId),
          isNull(schema.principalRoleAssignments.deletedAt),
          or(
            isNull(schema.principalRoleAssignments.expiresAt),
            gt(schema.principalRoleAssignments.expiresAt, now),
          ),
        ),
      )
      .limit(1);

    if (!row) return { agentId: agent.publicId, assignment: null };

    return {
      agentId: agent.publicId,
      assignment: {
        assignmentId: row.assignmentId,
        roleId: row.roleId,
        roleName: row.roleName,
        isSystemDefault: row.isSystemDefault,
        workspaceId: row.workspaceId,
        assignedAt: row.assignedAt.toISOString(),
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      },
    };
  });
}
