import { withTenantDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type {
  AgentTriggerDeleteInput,
  AgentTriggerDeleteOutput,
} from "@oxagen/oxagen/contracts/agent.trigger.delete";
import type { CapabilityContext } from "../types";
import { resolveTrigger } from "./_agent-definition";

export type { AgentTriggerDeleteInput, AgentTriggerDeleteOutput };

/**
 * Soft-delete a trigger — stamps deletedAt/deletedByUserId so the binding stops
 * firing while the audit record survives (hard deletes are prohibited on
 * org-scoped tables).
 */
export async function agentTriggerDeleteHandler(
  input: AgentTriggerDeleteInput,
  ctx: CapabilityContext,
): Promise<AgentTriggerDeleteOutput> {
  if (!ctx.userId) {
    throw new Error("agent.trigger.delete requires an authenticated user");
  }
  const userId = ctx.userId;

  return withTenantDb(async (tx) => {
    const existing = await resolveTrigger(input.triggerId, ctx.workspaceId, tx);
    if (!existing) {
      throw new Error(
        `Trigger "${input.triggerId}" not found in this workspace`,
      );
    }

    await tx
      .update(schema.agentTriggers)
      .set({
        deletedAt: new Date(),
        deletedByUserId: userId,
        enabled: false,
        updatedByUserId: userId,
      })
      .where(
        and(
          eq(schema.agentTriggers.id, existing.id),
          eq(schema.agentTriggers.workspaceId, ctx.workspaceId),
        ),
      );

    return { triggerId: existing.publicId, deleted: true };
  });
}
