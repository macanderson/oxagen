import type { CapabilityHandler } from "@oxagen/oxagen";
import { formSubmit } from "@oxagen/oxagen/contracts/form.submit";

export const formSubmitHandler: CapabilityHandler<typeof formSubmit> = async (
  input,
  _ctx,
) => {
  console.log(`[stub] form.submit form_id=${input.form_id}`);
  return {
    submission_id: `sub_stub_${Date.now()}`,
    status: "submitted",
    created_at: new Date().toISOString(),
  };
};
