import { unbindAgentEnvironment } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import type { AgentEnvironmentUnbindInput } from "@oxagen/oxagen/contracts/agent.environment.unbind";
import { logger } from "./logger";

export const agentEnvironmentUnbindHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[agent.environment.unbind] workspaceId is required (scoped capability)",
    );
  const args = input as AgentEnvironmentUnbindInput;
  const result = await unbindAgentEnvironment(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    args,
  );
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, agentId: args.agentId },
    "agent.environment.unbind: ok",
  );
  return result;
};
