import { bindAgentEnvironment } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import {
  agentEnvironmentBind,
  type AgentEnvironmentBindInput,
} from "@oxagen/oxagen/contracts/agent.environment.bind";
import { assertContractRole } from "./lib/capability-role-guard";
import { logger } from "./logger";

export const agentEnvironmentBindHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[agent.environment.bind] workspaceId is required (scoped capability)",
    );
  // The kernel's IAM check allows every capability for a non-enterprise org,
  // so the handler asks for the contract's roles itself (INV-29, #4194).
  await assertContractRole(agentEnvironmentBind, ctx);
  const args = input as AgentEnvironmentBindInput;
  const binding = await bindAgentEnvironment(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    args,
  );
  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      agentId: args.agentId,
      bindingId: binding.id,
    },
    "agent.environment.bind: ok",
  );
  return { binding };
};
