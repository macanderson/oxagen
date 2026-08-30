import { setDefaultTemplate } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const sandboxTemplateSetDefaultHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[set_default_sandbox_template] workspaceId is required (scoped capability)",
    );
  const { templateId } = input as { templateId: string };
  const template = await setDefaultTemplate(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { templateId },
  );
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, templateId: template.id },
    "sandbox.template.set_default: ok",
  );
  return { template };
};
