import { updateTemplate } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import type { SandboxTemplateUpdateInput } from "@oxagen/oxagen/contracts/sandbox.template.update";
import { logger } from "./logger";

export const sandboxTemplateUpdateHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[update_sandbox_template] workspaceId is required (scoped capability)",
    );
  const args = input as SandboxTemplateUpdateInput;
  const template = await updateTemplate(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    args,
  );
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, templateId: template.id },
    "sandbox.template.update: ok",
  );
  return { template };
};
