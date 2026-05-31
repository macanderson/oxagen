import type { CapabilityContext } from "../types.js";
import { dispatchFanout } from "../dispatch/subagent.js";
import type { AgentSubagentDispatchInput, AgentSubagentDispatchOutput } from "@oxagen/oxagen/contracts/agent.subagent.dispatch";

export type { AgentSubagentDispatchInput, AgentSubagentDispatchOutput };

export async function agentSubagentDispatchHandler(
  input: AgentSubagentDispatchInput,
  ctx: CapabilityContext,
): Promise<AgentSubagentDispatchOutput> {
  return dispatchFanout({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    parentMessageId: input.parentMessageId,
    children: input.fanout,
  });
}
