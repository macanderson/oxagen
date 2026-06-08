import type { CapabilityHandler } from "@oxagen/oxagen";
import { imageCreate } from "@oxagen/oxagen/contracts/image.create";

export const imageCreateHandler: CapabilityHandler<typeof imageCreate> = async (
  input,
  _ctx,
) => {
  console.log(`[stub] image.create prompt="${input.prompt}" model=${input.model}`);
  return {
    image_id: `img_stub_${Date.now()}`,
    url: "https://placehold.co/1024x1024",
    created_at: new Date().toISOString(),
  };
};
