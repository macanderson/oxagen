import { listAgentBindings } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import type { AgentEnvironmentListOutput } from "@oxagen/oxagen/contracts/agent.environment.list";

export const agentEnvironmentListHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[agent.environment.list] workspaceId is required (scoped capability)",
    );
  const { agentId } = input as { agentId: string };
  const bindings = await listAgentBindings(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { agentId },
  );
  return { bindings } satisfies AgentEnvironmentListOutput;
};
