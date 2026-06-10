import type { CapabilityHandler } from "@oxagen/oxagen";
import { pluginVersionList } from "@oxagen/oxagen/contracts/plugin.version.list";
import { logger } from "./logger";

export const pluginVersionListHandler: CapabilityHandler<typeof pluginVersionList> = async (input, _ctx) => {
  // TODO: Query plugin catalog/registry for version history; check org's installed version
  // against current to compute hasBreakingUpdate
  logger.info(
    { pluginId: input.pluginId, limit: input.limit },
    "plugin.version.list: fetched (stub)",
  );

  return {
    pluginId: input.pluginId,
    currentVersion: "1.0.0",
    installedVersion: null,
    hasBreakingUpdate: false,
    versions: [],
  };
};
