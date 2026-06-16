import { withTenantDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { agentTriggerSchema } from "@oxagen/oxagen/agent-schema";
import type {
  AgentTriggerUpdateInput,
  AgentTriggerUpdateOutput,
} from "@oxagen/oxagen/contracts/agent.trigger.update";
import type { CapabilityContext } from "../types";
import { resolveTrigger } from "./_agent-definition";

export type { AgentTriggerUpdateInput, AgentTriggerUpdateOutput };

/**
 * Update an existing trigger in place — replaces its type-specific binding and
 * enabled flag with a freshly validated agentTriggerSchema payload.
 */
export async function agentTriggerUpdateHandler(
  input: AgentTriggerUpdateInput,
  ctx: CapabilityContext,
): Promise<AgentTriggerUpdateOutput> {
  const trigger = agentTriggerSchema.parse(input.trigger);

  if (!ctx.userId) {
    throw new Error("agent.trigger.update requires an authenticated user");
  }
  const userId = ctx.userId;

  return withTenantDb(async (tx) => {
    const existing = await resolveTrigger(input.triggerId, ctx.workspaceId, tx);
    if (!existing) {
      throw new Error(
        `Trigger "${input.triggerId}" not found in this workspace`,
      );
    }

    const [row] = await tx
      .update(schema.agentTriggers)
      .set({
        triggerType: trigger.type,
        eventSource: trigger.eventSource ?? null,
        eventType: trigger.eventType ?? null,
        connectionId: trigger.connectionId ?? null,
        filter: trigger.filter ?? {},
        schedule: trigger.schedule ?? null,
        enabled: trigger.enabled,
        updatedByUserId: userId,
      })
      .where(
        and(
          eq(schema.agentTriggers.id, existing.id),
          eq(schema.agentTriggers.workspaceId, ctx.workspaceId),
        ),
      )
      .returning({
        publicId: schema.agentTriggers.publicId,
        triggerType: schema.agentTriggers.triggerType,
        enabled: schema.agentTriggers.enabled,
      });
    if (!row) throw new Error("agent_triggers update failed");

    return {
      triggerId: row.publicId,
      triggerType: row.triggerType as "manual" | "schedule" | "event",
      enabled: row.enabled,
    };
  });
}
