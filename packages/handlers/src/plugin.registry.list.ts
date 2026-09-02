// audit-exempt: read-only listing of MCP registries — no state mutation; the kernel capability.invoke_* audit covers access.
import { and, eq } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (_input, ctx) => {
  const { orgId, workspaceId } = ctx;

  let rows: {
    id: string;
    name: string;
    baseUrl: string;
    enabled: boolean;
    isDefault: boolean;
  }[];
  try {
    rows = await withTenantDb((tx) =>
      tx
        .select({
          id: schema.mcpRegistries.id,
          name: schema.mcpRegistries.name,
          baseUrl: schema.mcpRegistries.baseUrl,
          enabled: schema.mcpRegistries.enabled,
          isDefault: schema.mcpRegistries.isDefault,
        })
        .from(schema.mcpRegistries)
        .where(
          and(
            eq(schema.mcpRegistries.orgId, orgId),
            eq(schema.mcpRegistries.workspaceId, workspaceId),
          ),
        ),
    );
  } catch (err) {
    logger.error({ err, orgId, workspaceId }, "plugin.registry.list: failed");
    throw err;
  }

  logger.info(
    { orgId, workspaceId, count: rows.length },
    "plugin.registry.list: ok",
  );
  return {
    registries: rows.map((r) => ({
      id: r.id,
      name: r.name,
      baseUrl: r.baseUrl,
      enabled: r.enabled,
      isDefault: r.isDefault,
    })),
  };
};
