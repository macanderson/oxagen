// audit-exempt: adds an MCP registry source (a discovery endpoint, not a credential or access grant). No fitting security-event type exists in the taxonomy (no plugin.registry_* family); covered by the kernel capability.invoke_* audit. Do not invent a type.
import { withTenantDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { pluginRegistryAdd } from "@oxagen/oxagen/contracts/plugin.registry.add";
import { assertContractRole } from "./lib/capability-role-guard";
import { addRegistry } from "./registry-default";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  // The kernel's IAM check allows every capability for a non-enterprise org,
  // so the handler asks for the contract's roles itself (INV-29, #4194).
  await assertContractRole(pluginRegistryAdd, ctx);
  const { name, baseUrl } = input as { name: string; baseUrl: string };
  const { orgId, workspaceId } = ctx;

  let result: { id: string; isDefault: boolean };
  try {
    result = await withTenantDb((tx) =>
      addRegistry(tx, { orgId, workspaceId, name, baseUrl }),
    );
  } catch (err) {
    logger.error(
      { err, orgId, workspaceId, name, baseUrl },
      "plugin.registry.add: insert failed",
    );
    throw err;
  }

  logger.info(
    {
      registryId: result.id,
      orgId,
      workspaceId,
      name,
      isDefault: result.isDefault,
    },
    "plugin.registry.add: ok",
  );
  return { registryId: result.id, isDefault: result.isDefault };
};
