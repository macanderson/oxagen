import { withTenantDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type {
  AgentDefinitionDeleteInput,
  AgentDefinitionDeleteOutput,
} from "@oxagen/oxagen/contracts/agent.definition.delete";
import type { CapabilityContext } from "../types";
import { resolveAgent, assertAgentMutable } from "./_agent-definition";

export type { AgentDefinitionDeleteInput, AgentDefinitionDeleteOutput };

/**
 * Soft-delete an agent definition AND its delegated IAM principal together
 * (docs/specs/agent-rbac/spec.md §2.1): an agent identity and its principal
 * share one lifecycle — deleting the agent must never leave an orphaned
 * "live" principal a since-deleted agent could still be attributed through.
 * Hard deletes are prohibited on org-scoped tables; both rows are retained
 * for audit (agents.deletedAt, principals.status='deleted').
 */
export async function agentDefinitionDeleteHandler(
  input: AgentDefinitionDeleteInput,
  ctx: CapabilityContext,
): Promise<AgentDefinitionDeleteOutput> {
  if (!ctx.userId) {
    throw new Error("agent.definition.delete requires an authenticated user");
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

    // Resolve principalId directly off the row (resolveAgent's projected
    // AgentRow doesn't carry it) — same tx, so it reflects the pre-delete
    // state written at agent.definition.create.
    const [row] = await tx
      .select({ principalId: schema.agents.principalId })
      .from(schema.agents)
      .where(eq(schema.agents.id, agent.id))
      .limit(1);

    if (row?.principalId) {
      await tx
        .update(schema.principals)
        .set({
          status: "deleted",
          updatedByUserId: userId,
        })
        .where(eq(schema.principals.id, row.principalId));
    }

    return { agentId: agent.publicId, deleted: true };
  });
}
