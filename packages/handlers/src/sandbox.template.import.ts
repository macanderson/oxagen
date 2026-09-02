import { importTemplate } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import type { SandboxTemplateImportInput } from "@oxagen/oxagen/contracts/sandbox.template.import";
import { logger } from "./logger";

export const sandboxTemplateImportHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[import_sandbox_template] workspaceId is required (scoped capability)",
    );
  const args = input as SandboxTemplateImportInput;
  const result = await importTemplate(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    args,
  );
  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      templateId: result.template.id,
      warnings: result.warnings.length,
    },
    "sandbox.template.import: ok",
  );
  return result;
};
