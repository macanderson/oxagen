import type { CapabilityHandler } from "@oxagen/oxagen";
import { formCreate } from "@oxagen/oxagen/contracts/form.create";

export const formCreateHandler: CapabilityHandler<typeof formCreate> = async (
  input,
  _ctx,
) => {
  console.log(`[stub] form.create title="${input.title}" fields=${(input.fields ?? []).length}`);
  return {
    form_id: `form_stub_${Date.now()}`,
    title: input.title,
    created_at: new Date().toISOString(),
  };
};
