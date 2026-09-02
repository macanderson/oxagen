import { exportTemplate } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

export const sandboxTemplateExportHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[export_sandbox_template] workspaceId is required (scoped capability)",
    );
  const { templateId } = input as { templateId: string };
  const manifest = await exportTemplate(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { templateId },
  );
  return { manifest };
};
