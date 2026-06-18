import { withTenantDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { addRegistry } from "./registry-default";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { name, baseUrl } = input as { name: string; baseUrl: string };
  const { orgId, workspaceId } = ctx;

  let result: { id: string; isDefault: boolean };
  try {
    result = await withTenantDb((tx) => addRegistry(tx, { orgId, workspaceId, name, baseUrl }));
  } catch (err) {
    logger.error(
      { err, orgId, workspaceId, name, baseUrl },
      "plugin.registry.add: insert failed",
    );
    throw err;
  }

  logger.info(
    { registryId: result.id, orgId, workspaceId, name, isDefault: result.isDefault },
    "plugin.registry.add: ok",
  );
  return { registryId: result.id, isDefault: result.isDefault };
};
