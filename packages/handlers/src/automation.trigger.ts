import type { CapabilityHandler } from "@oxagen/oxagen";
import { automationTrigger } from "@oxagen/oxagen/contracts/automation.trigger";

export const automationTriggerHandler: CapabilityHandler<typeof automationTrigger> = async (
  input,
  _ctx,
) => {
  console.log(`[stub] automation.trigger automation_id=${input.automation_id}`);
  return {
    execution_id: `exec_stub_${Date.now()}`,
    status: "running",
  };
};
