import type { CapabilityHandler } from "@oxagen/oxagen";
import { skillWorkspaceList } from "@oxagen/oxagen/contracts/skill.workspace.list";

export const skillWorkspaceListHandler: CapabilityHandler<typeof skillWorkspaceList> = async (
  input,
  ctx,
) => {
  console.log(`[stub] skill.workspace.list workspace=${input.workspace_id ?? ctx.workspaceId}`);
  return { skills: [] };
};
