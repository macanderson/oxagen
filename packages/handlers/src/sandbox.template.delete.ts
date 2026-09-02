import { deleteTemplate } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const sandboxTemplateDeleteHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[delete_sandbox_template] workspaceId is required (scoped capability)",
    );
  const { templateId } = input as { templateId: string };
  const result = await deleteTemplate(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { templateId },
  );
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, templateId },
    "sandbox.template.delete: ok",
  );
  return result;
};
