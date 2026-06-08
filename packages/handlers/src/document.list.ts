import type { CapabilityHandler } from "@oxagen/oxagen";
import { documentList } from "@oxagen/oxagen/contracts/document.list";

export const documentListHandler: CapabilityHandler<typeof documentList> = async (
  input,
  ctx,
) => {
  console.log(`[stub] document.list workspace=${input.workspace_id ?? ctx.workspaceId}`);
  return { documents: [] };
};
