// agent.role.list — list the IAM roles attached to an agent's delegated
// principal (Agent RBAC Phase 1, docs/specs/agent-rbac/spec.md §3.2).
//
// Read-only introspection: active (non-deleted, non-expired) rows from
// iam.principal_role_assignments joined to iam.roles, honouring the
// assignment's workspace scope (org-wide rows + rows scoped to the current
// workspace). A pre-RBAC agent with no delegated principal lists zero roles
// rather than erroring — introspection must never fail on legacy data.

import { withTenantDb, schema } from "@oxagen/database";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type {
  AgentRoleListInput,
  AgentRoleListOutput,
} from "@oxagen/oxagen/contracts/agent.role.list";
import type { CapabilityContext } from "../types";
import { resolveAgentForRoles } from "./_agent-role";

export type { AgentRoleListInput, AgentRoleListOutput };

export async function agentRoleListHandler(
  input: AgentRoleListInput,
  ctx: CapabilityContext,
): Promise<AgentRoleListOutput> {
  if (!ctx.orgId || !ctx.workspaceId) {
    throw new Error("Forbidden: org and workspace scope are required");
  }

  return withTenantDb(async (tx) => {
    const agent = await resolveAgentForRoles(
      tx,
      input.agentId,
      ctx.workspaceId,
    );

    if (!agent.principalId) {
      return { agentId: agent.publicId, roles: [], total: 0 };
    }

    const rows = await tx
      .select({
        assignmentId: schema.principalRoleAssignments.publicId,
        roleId: schema.roles.publicId,
        roleName: schema.roles.name,
        scopeKind: schema.roles.scopeKind,
        isSystemDefault: schema.roles.isSystemDefault,
        assignedAt: schema.principalRoleAssignments.assignedAt,
        assignedBy: schema.principalRoleAssignments.assignedBy,
        expiresAt: schema.principalRoleAssignments.expiresAt,
        workspaceId: schema.principalRoleAssignments.workspaceId,
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
            gt(schema.principalRoleAssignments.expiresAt, sql`now()`),
          ),
          or(
            isNull(schema.principalRoleAssignments.workspaceId),
            eq(schema.principalRoleAssignments.workspaceId, ctx.workspaceId),
          ),
        ),
      )
      .orderBy(desc(schema.principalRoleAssignments.assignedAt));

    const roles = rows.map((r) => ({
      assignmentId: r.assignmentId,
      roleId: r.roleId,
      roleName: r.roleName,
      scopeKind: r.scopeKind as "org" | "workspace",
      isSystemDefault: r.isSystemDefault,
      assignedAt: r.assignedAt.toISOString(),
      assignedBy: r.assignedBy ?? null,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      workspaceId: r.workspaceId ?? null,
    }));

    return { agentId: agent.publicId, roles, total: roles.length };
  });
}
