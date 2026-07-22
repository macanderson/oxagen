import { withTenantDb, schema } from "@oxagen/database";
import type {
  AgentRoleListInput,
  AgentRoleListOutput,
  AgentRoleAssignmentRow,
} from "@oxagen/oxagen/contracts/agent.role.list";
import type { CapabilityContext } from "../types";
import { and, eq, isNull, or, gt } from "drizzle-orm";
import { resolveAgent } from "./_agent-definition";

export type { AgentRoleListInput, AgentRoleListOutput };

/**
 * agent.role.list handler — active (non-revoked, non-expired) role
 * assignments for one agent's principal.
 */
export async function agentRoleListHandler(
  input: AgentRoleListInput,
  ctx: CapabilityContext,
): Promise<AgentRoleListOutput> {
  return withTenantDb(async (tx) => {
    const agent = await resolveAgent(input.agentId, ctx.workspaceId, tx);
    if (!agent) throw new Error(`Agent "${input.agentId}" not found`);
    if (!agent.principalId) {
      return { agentId: agent.publicId, assignments: [] };
    }

    const now = new Date();
    const rows = await tx
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
          eq(schema.principalRoleAssignments.orgId, ctx.orgId),
          isNull(schema.principalRoleAssignments.deletedAt),
          or(
            isNull(schema.principalRoleAssignments.expiresAt),
            gt(schema.principalRoleAssignments.expiresAt, now),
          ),
        ),
      );

    const assignments: AgentRoleAssignmentRow[] = rows.map((r) => ({
      assignmentId: r.assignmentId,
      roleId: r.roleId,
      roleName: r.roleName,
      isSystemDefault: r.isSystemDefault,
      workspaceId: r.workspaceId,
      assignedAt: r.assignedAt.toISOString(),
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    }));

    return { agentId: agent.publicId, assignments };
  });
}
