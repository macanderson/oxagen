import type { CapabilityHandler } from "@oxagen/oxagen";
import { workspaceMemberList } from "@oxagen/oxagen/contracts/workspace.member.list";

export const workspaceMemberListHandler: CapabilityHandler<typeof workspaceMemberList> = async (
  input,
  ctx,
) => {
  console.log(`[stub] workspace.member.list workspace=${input.workspace_id ?? ctx.workspaceId}`);
  return [];
};
