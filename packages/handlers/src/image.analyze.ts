import type { CapabilityHandler } from "@oxagen/oxagen";
import { imageAnalyze } from "@oxagen/oxagen/contracts/image.analyze";

export const imageAnalyzeHandler: CapabilityHandler<typeof imageAnalyze> = async (
  input,
  _ctx,
) => {
  console.log(`[stub] image.analyze image_id=${input.image_id}`);
  return {
    analysis: "Stub analysis — image analysis is not yet implemented.",
    tags: [],
    description: "Stub description.",
  };
};
