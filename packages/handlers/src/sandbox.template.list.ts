import { listTemplates } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import type { SandboxTemplateListInput } from "@oxagen/oxagen/contracts/sandbox.template.list";

export const sandboxTemplateListHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[list_sandbox_templates] workspaceId is required (scoped capability)",
    );
  const { environmentId } = input as SandboxTemplateListInput;
  const templates = await listTemplates(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { environmentId },
  );
  return { templates };
};
