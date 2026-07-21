import { withTenantDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type {
  AgentDefinitionArchiveInput,
  AgentDefinitionArchiveOutput,
} from "@oxagen/oxagen/contracts/agent.definition.archive";
import type { CapabilityContext } from "../types";
import { resolveAgent, assertAgentMutable } from "./_agent-definition";

export type { AgentDefinitionArchiveInput, AgentDefinitionArchiveOutput };

/**
 * Archive an agent identity: soft-deletes the agent row (status='archived' +
 * deletedAt) AND soft-deletes its IAM agent principal in the same
 * transaction. The principal is the agent's IAM identity — retiring the
 * agent without retiring the principal would leave a live, roleable
 * principal with no agent behind it (docs/specs/agent-rbac/spec.md §3.1,
 * goal #1: "created at agent.definition.create and soft-deleted with the
 * agent"). Irreversible.
 */
export async function agentDefinitionArchiveHandler(
  input: AgentDefinitionArchiveInput,
  ctx: CapabilityContext,
): Promise<AgentDefinitionArchiveOutput> {
  if (!ctx.userId) {
    throw new Error("agent.definition.archive requires an authenticated user");
  }
  const userId = ctx.userId;

  return withTenantDb(async (tx) => {
    const agent = await resolveAgent(input.agentId, ctx.workspaceId, tx);
    if (!agent) {
      throw new Error(`Agent "${input.agentId}" not found in this workspace`);
    }
    assertAgentMutable(agent);

    await tx
      .update(schema.agents)
      .set({
        status: "archived",
        deploymentStatus: "inactive",
        deletedAt: new Date(),
        deletedByUserId: userId,
        updatedByUserId: userId,
      })
      .where(
        and(
          eq(schema.agents.id, agent.id),
          eq(schema.agents.workspaceId, ctx.workspaceId),
        ),
      );

    // Soft-delete the agent's IAM principal alongside it — a retired agent
    // must vanish from IAM (role assignments, effective-permission
    // resolution) together with its identity row, not survive as an
    // orphaned, still-active principal. iam.principals has no
    // deletedAt/deletedByUserId columns (no softDeleteMixin) — the
    // established convention (org.member.remove.ts) is status='deleted'.
    if (agent.principalId) {
      await tx
        .update(schema.principals)
        .set({
          status: "deleted",
          updatedAt: new Date(),
          updatedByUserId: userId,
        })
        .where(eq(schema.principals.id, agent.principalId));
    }

    return { agentId: agent.publicId, archived: true as const };
  });
}
