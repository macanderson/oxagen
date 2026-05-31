import type { CapabilityHandler } from "@oxagen/oxagen";
import { brandkitApply } from "@oxagen/oxagen/contracts/brandkit.apply";

export const brandkitApplyHandler: CapabilityHandler<typeof brandkitApply> = async (
  input,
  _ctx,
) => {
  console.log(
    `[stub] brandkit.apply would apply brand kit ${input.brandKitId} to ${input.targetFileId} in workspace ${input.workspaceId}`,
  );

  return {
    stub: true,
    applied: false,
    brandKitId: input.brandKitId,
    targetFileId: input.targetFileId,
  };
};
