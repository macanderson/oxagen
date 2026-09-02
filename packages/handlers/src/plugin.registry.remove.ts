// audit-exempt: removes an MCP registry source (a discovery endpoint, not a credential or access grant). No fitting security-event type exists in the taxonomy (no plugin.registry_* family); covered by the kernel capability.invoke_* audit. Do not invent a type.
import { withTenantDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { removeRegistry } from "./registry-default";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { registryId } = input as { registryId: string };
  const { orgId, workspaceId } = ctx;

  let result: { removed: boolean; promotedId: string | null };
  try {
    result = await withTenantDb((tx) =>
      removeRegistry(tx, { orgId, workspaceId, registryId }),
    );
  } catch (err) {
    logger.error(
      { err, registryId, orgId, workspaceId },
      "plugin.registry.remove: failed",
    );
    throw err;
  }

  logger.info(
    {
      registryId,
      orgId,
      workspaceId,
      removed: result.removed,
      promotedId: result.promotedId,
    },
    "plugin.registry.remove: ok",
  );
  return { ok: result.removed, promotedId: result.promotedId };
};
