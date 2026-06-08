import type { CapabilityHandler } from "@oxagen/oxagen";
import { imageList } from "@oxagen/oxagen/contracts/image.list";

export const imageListHandler: CapabilityHandler<typeof imageList> = async (
  input,
  ctx,
) => {
  console.log(`[stub] image.list workspace=${input.workspace_id ?? ctx.workspaceId}`);
  return { images: [] };
};
