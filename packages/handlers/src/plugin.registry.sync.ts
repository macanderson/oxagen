import { inngest } from "@oxagen/inngest-functions/client";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

export const handler: CapabilityHandlerFn = async (input) => {
  const { registryId, mode } = input as { registryId: string; mode: "full" | "incremental" };
  await inngest.send({ name: "plugin/registry.sync", data: { registryId, mode } });
  return { accepted: true };
};
