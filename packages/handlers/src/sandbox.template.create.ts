import { createTemplate } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import type { SandboxTemplateCreateInput } from "@oxagen/oxagen/contracts/sandbox.template.create";
import { logger } from "./logger";

export const sandboxTemplateCreateHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[create_sandbox_template] workspaceId is required (scoped capability)",
    );
  const args = input as SandboxTemplateCreateInput;
  const template = await createTemplate(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    args,
  );
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, templateId: template.id },
    "sandbox.template.create: ok",
  );
  return { template };
};
