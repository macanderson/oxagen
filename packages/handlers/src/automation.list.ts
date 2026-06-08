import type { CapabilityHandler } from "@oxagen/oxagen";
import { automationList } from "@oxagen/oxagen/contracts/automation.list";

export const automationListHandler: CapabilityHandler<typeof automationList> = async (
  input,
  ctx,
) => {
  console.log(`[stub] automation.list workspace=${input.workspace_id ?? ctx.workspaceId}`);
  return [];
};
