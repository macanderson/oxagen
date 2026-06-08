import type { CapabilityHandler } from "@oxagen/oxagen";
import { automationCreate } from "@oxagen/oxagen/contracts/automation.create";

export const automationCreateHandler: CapabilityHandler<typeof automationCreate> = async (
  input,
  _ctx,
) => {
  console.log(`[stub] automation.create name="${input.name}"`);
  return {
    automation_id: `auto_stub_${Date.now()}`,
    name: input.name,
    status: "active",
  };
};
