import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import type {
  AgentTriggerListInput,
  AgentTriggerListOutput,
} from "@oxagen/oxagen/contracts/agent.trigger.list";
import type { CapabilityContext } from "../types";
import { resolveAgent } from "./_agent-definition";

export type { AgentTriggerListInput, AgentTriggerListOutput };

/** List an agent's live (non-deleted) triggers, workspace-scoped. */
export async function agentTriggerListHandler(
  input: AgentTriggerListInput,
  ctx: CapabilityContext,
): Promise<AgentTriggerListOutput> {
  return withTenantDb(async (tx) => {
    const agent = await resolveAgent(input.agentId, ctx.workspaceId, tx);
    if (!agent) {
      throw new Error(`Agent "${input.agentId}" not found in this workspace`);
    }

    const rows = await tx
      .select({
        id: schema.agentTriggers.id,
        publicId: schema.agentTriggers.publicId,
        triggerType: schema.agentTriggers.triggerType,
        eventSource: schema.agentTriggers.eventSource,
        eventType: schema.agentTriggers.eventType,
        connectionId: schema.agentTriggers.connectionId,
        filter: schema.agentTriggers.filter,
        schedule: schema.agentTriggers.schedule,
        enabled: schema.agentTriggers.enabled,
      })
      .from(schema.agentTriggers)
      .where(
        and(
          eq(schema.agentTriggers.agentId, agent.id),
          eq(schema.agentTriggers.workspaceId, ctx.workspaceId),
          isNull(schema.agentTriggers.deletedAt),
        ),
      );

    return {
      triggers: rows.map((r) => ({
        triggerId: r.publicId,
        publicId: r.publicId,
        triggerType: r.triggerType as "manual" | "schedule" | "event",
        eventSource: r.eventSource,
        eventType: r.eventType,
        connectionId: r.connectionId,
        filter: (r.filter ?? {}) as Record<string, unknown>,
        schedule: r.schedule,
        enabled: r.enabled,
      })),
    };
  });
}
