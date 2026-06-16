import { withTenantDb, schema } from "@oxagen/database";
import { agentTriggerSchema } from "@oxagen/oxagen/agent-schema";
import type {
  AgentTriggerCreateInput,
  AgentTriggerCreateOutput,
} from "@oxagen/oxagen/contracts/agent.trigger.create";
import type { CapabilityContext } from "../types";
import { resolveAgent } from "./_agent-definition";

export type { AgentTriggerCreateInput, AgentTriggerCreateOutput };

/**
 * Create a trigger for an agent. The trigger shape is re-validated against
 * agentTriggerSchema (the superRefine enforces e.g. event triggers carrying a
 * source/type) before insert.
 */
export async function agentTriggerCreateHandler(
  input: AgentTriggerCreateInput,
  ctx: CapabilityContext,
): Promise<AgentTriggerCreateOutput> {
  const trigger = agentTriggerSchema.parse(input.trigger);

  if (!ctx.userId) {
    throw new Error("agent.trigger.create requires an authenticated user");
  }
  const userId = ctx.userId;

  return withTenantDb(async (tx) => {
    const agent = await resolveAgent(input.agentId, ctx.workspaceId, tx);
    if (!agent) {
      throw new Error(`Agent "${input.agentId}" not found in this workspace`);
    }

    const [row] = await tx
      .insert(schema.agentTriggers)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        agentId: agent.id,
        triggerType: trigger.type,
        eventSource: trigger.eventSource ?? null,
        eventType: trigger.eventType ?? null,
        connectionId: trigger.connectionId ?? null,
        filter: trigger.filter ?? {},
        schedule: trigger.schedule ?? null,
        enabled: trigger.enabled,
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .returning({
        id: schema.agentTriggers.id,
        publicId: schema.agentTriggers.publicId,
        triggerType: schema.agentTriggers.triggerType,
        enabled: schema.agentTriggers.enabled,
      });
    if (!row) throw new Error("agent_triggers insert failed");

    return {
      triggerId: row.publicId,
      publicId: row.publicId,
      triggerType: row.triggerType as "manual" | "schedule" | "event",
      enabled: row.enabled,
    };
  });
}
