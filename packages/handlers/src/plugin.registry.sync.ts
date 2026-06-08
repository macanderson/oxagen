import { inngest } from "@oxagen/inngest-functions/client";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input) => {
  const { registryId, mode } = input as { registryId: string; mode: "full" | "incremental" };
  try {
    await inngest.send({ name: "plugin/registry.sync", data: { registryId, mode } });
  } catch (err) {
    logger.error({ err, registryId, mode }, "plugin.registry.sync: inngest send failed");
    throw err;
  }
  logger.info({ registryId, mode }, "plugin.registry.sync: accepted");
  return { accepted: true };
};
