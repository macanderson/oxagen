import type { CapabilityContext } from "../types.js";
import { dispatchFanout } from "../dispatch/subagent.js";

export interface AgentSubagentDispatchInput {
  parentMessageId: string;
  fanout: Array<{ capability: string; input: unknown; label?: string }>;
}

export interface AgentSubagentDispatchOutput {
  fanoutId: string;
  childMessageIds: string[];
}

export async function agentSubagentDispatchHandler(
  input: AgentSubagentDispatchInput,
  ctx: CapabilityContext,
): Promise<AgentSubagentDispatchOutput> {
  return dispatchFanout({
    tenantId: ctx.tenantId,
    workspaceId: ctx.workspaceId,
    parentMessageId: input.parentMessageId,
    children: input.fanout,
  });
}
