import { getTemplate } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

export const sandboxTemplateGetHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[get_sandbox_template] workspaceId is required (scoped capability)",
    );
  const { templateId } = input as { templateId: string };
  const template = await getTemplate(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { templateId },
  );
  return { template };
};
