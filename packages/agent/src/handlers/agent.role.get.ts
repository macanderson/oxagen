// agent.role.get — inspect one IAM role relative to an agent's delegated
// principal (Agent RBAC Phase 1, docs/specs/agent-rbac/spec.md §3.2).
//
// Resolves the named role (typed agent_role_not_found when absent), reports
// whether the agent's principal currently holds it, and returns the role's
// capability grant list so a reviewer sees exactly what attaching it confers.

import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type {
  AgentRoleGetInput,
  AgentRoleGetOutput,
} from "@oxagen/oxagen/contracts/agent.role.get";
import type { CapabilityContext } from "../types";
import { resolveAgentForRoles, resolveRoleByName } from "./_agent-role";

export type { AgentRoleGetInput, AgentRoleGetOutput };

export async function agentRoleGetHandler(
  input: AgentRoleGetInput,
  ctx: CapabilityContext,
): Promise<AgentRoleGetOutput> {
  if (!ctx.orgId || !ctx.workspaceId) {
    throw new Error("Forbidden: org and workspace scope are required");
  }

  return withTenantDb(async (tx) => {
    const agent = await resolveAgentForRoles(
      tx,
      input.agentId,
      ctx.workspaceId,
    );

    const role = await resolveRoleByName(tx, ctx.orgId, input.roleName);

    let assignment: AgentRoleGetOutput["assignment"] = null;
    if (agent.principalId) {
      const [row] = await tx
        .select({
          assignmentId: schema.principalRoleAssignments.publicId,
          assignedAt: schema.principalRoleAssignments.assignedAt,
          assignedBy: schema.principalRoleAssignments.assignedBy,
          expiresAt: schema.principalRoleAssignments.expiresAt,
          workspaceId: schema.principalRoleAssignments.workspaceId,
        })
        .from(schema.principalRoleAssignments)
        .where(
          and(
            eq(schema.principalRoleAssignments.principalId, agent.principalId),
            eq(schema.principalRoleAssignments.roleId, role.id),
            eq(schema.principalRoleAssignments.orgId, ctx.orgId),
            isNull(schema.principalRoleAssignments.deletedAt),
            or(
              isNull(schema.principalRoleAssignments.expiresAt),
              gt(schema.principalRoleAssignments.expiresAt, sql`now()`),
            ),
            or(
              isNull(schema.principalRoleAssignments.workspaceId),
              eq(schema.principalRoleAssignments.workspaceId, ctx.workspaceId),
            ),
          ),
        )
        .limit(1);
      if (row) {
        assignment = {
          assignmentId: row.assignmentId,
          roleId: role.publicId,
          roleName: role.name,
          scopeKind: role.scopeKind as "org" | "workspace",
          isSystemDefault: role.isSystemDefault,
          assignedAt: row.assignedAt.toISOString(),
          assignedBy: row.assignedBy ?? null,
          expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
          workspaceId: row.workspaceId ?? null,
        };
      }
    }

    const grantRows = await tx
      .select({
        capability: schema.roleGrants.capabilityId,
        effect: schema.roleGrants.effect,
      })
      .from(schema.roleGrants)
      .where(eq(schema.roleGrants.roleId, role.id));

    return {
      agentId: agent.publicId,
      roleId: role.publicId,
      roleName: role.name,
      assigned: assignment !== null,
      assignment,
      grants: grantRows.map((g) => ({
        capability: g.capability,
        effect: g.effect as "allow" | "deny" | "require_approval",
      })),
    };
  });
}
