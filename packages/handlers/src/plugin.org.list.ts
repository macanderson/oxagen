// audit-exempt: read-only listing of installed plugins — no state mutation; the kernel capability.invoke_* audit covers access.
import { and, asc, eq, isNull } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  if (!ctx.workspaceId) {
    throw new Error(
      "[plugin.org.list] workspaceId is required (scoped capability)",
    );
  }
  const orgId = ctx.orgId;
  const workspaceId = ctx.workspaceId;
  const { pluginType } = input as {
    pluginType?:
      | "mcp_server"
      | "integration"
      | "agent_skill"
      | "agent_capability"
      | "knowledge_source";
  };

  const conds = [
    eq(schema.pluginInstalledPlugins.orgId, orgId),
    eq(schema.pluginInstalledPlugins.workspaceId, workspaceId),
    isNull(schema.pluginInstalledPlugins.deletedAt),
  ];
  if (pluginType) {
    conds.push(eq(schema.pluginInstalledPlugins.pluginType, pluginType));
  }

  try {
    return await withTenantDb(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.pluginInstalledPlugins)
        .where(and(...conds))
        .orderBy(asc(schema.pluginInstalledPlugins.name));

      logger.info(
        { orgId, workspaceId, listingCount: rows.length },
        "plugin.org.list: ok",
      );
      return {
        listings: rows.map((r) => ({
          id: r.id,
          publicId: r.publicId,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
          createdByUserId: r.createdByUserId ?? null,
          updatedByUserId: r.updatedByUserId ?? null,
          deletedAt: r.deletedAt?.toISOString() ?? null,
          deletedByUserId: r.deletedByUserId ?? null,
          orgId: r.orgId,
          workspaceId: r.workspaceId,
          pluginType: r.pluginType,
          source: r.source,
          name: r.name,
          title: r.title ?? null,
          description: r.description ?? null,
          iconUrl: r.iconUrl ?? null,
          endpointUrl: r.endpointUrl ?? null,
          transport: r.transport ?? null,
          authKind: r.authKind,
          authConfig: (r.authConfig as Record<string, unknown>) ?? {},
          enabled: r.enabled,
          config: (r.config as Record<string, unknown>) ?? {},
        })),
      };
    });
  } catch (err) {
    logger.error({ err, orgId, workspaceId }, "plugin.org.list: failed");
    throw err;
  }
};
