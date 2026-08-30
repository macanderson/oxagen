import { setTemplateTools } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import type { SandboxTemplateSetToolsInput } from "@oxagen/oxagen/contracts/sandbox.template.set_tools";
import { logger } from "./logger";

export const sandboxTemplateSetToolsHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[set_sandbox_template_tools] workspaceId is required (scoped capability)",
    );
  const args = input as SandboxTemplateSetToolsInput;
  const template = await setTemplateTools(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    args,
  );
  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      templateId: template.id,
      tools: args.tools.length,
    },
    "sandbox.template.set_tools: ok",
  );
  return { template };
};
