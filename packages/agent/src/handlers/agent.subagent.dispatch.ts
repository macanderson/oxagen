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
    // Coerce each fanout child to FanoutChild: `capability` is required there,
    // but Vercel's declaration-emit tsc infers the parsed field as optional.
    children: input.fanout.map((c) => ({ capability: c.capability ?? "", input: c.input, label: c.label })),
  });
}
