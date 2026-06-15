import { and, asc, eq, isNull, or, SQL } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const orgId = ctx.orgId;
  const { pluginType, workspaceId } = input as {
    pluginType?: "mcp_server" | "integration" | "content_tool";
    workspaceId?: string;
  };

  const listingConds = [
    eq(schema.pluginOrgListings.orgId, orgId),
    isNull(schema.pluginOrgListings.deletedAt),
  ];
  if (pluginType) {
    listingConds.push(eq(schema.pluginOrgListings.pluginType, pluginType));
  }
  // When workspaceId is provided, include workspace-scoped rows and org-level (NULL) rows.
  // When not provided, return all listings for the org (org-level + all workspace installs).
  if (workspaceId) {
    const wsCond = or(
      eq(schema.pluginOrgListings.workspaceId, workspaceId),
      isNull(schema.pluginOrgListings.workspaceId),
    ) as SQL<unknown>;
    listingConds.push(wsCond);
  }

  const denylistConds = [eq(schema.pluginOrgDenylist.orgId, orgId)];
  if (pluginType) {
    denylistConds.push(eq(schema.pluginOrgDenylist.pluginType, pluginType));
  }

  try {
    return await withSystemDb(async (tx) => {
      const [listingRows, denylistRows] = await Promise.all([
        tx
          .select()
          .from(schema.pluginOrgListings)
          .where(and(...listingConds))
          .orderBy(asc(schema.pluginOrgListings.name)),
        tx
          .select()
          .from(schema.pluginOrgDenylist)
          .where(and(...denylistConds))
          .orderBy(asc(schema.pluginOrgDenylist.serverName)),
      ]);

      logger.info({ orgId, listingCount: listingRows.length, denylistCount: denylistRows.length }, "plugin.org.list: ok");
      return {
        listings: listingRows.map((r) => ({
          id: r.id,
          publicId: r.publicId,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
          createdByUserId: r.createdByUserId ?? null,
          updatedByUserId: r.updatedByUserId ?? null,
          deletedAt: r.deletedAt?.toISOString() ?? null,
          deletedByUserId: r.deletedByUserId ?? null,
          orgId: r.orgId,
          workspaceId: r.workspaceId ?? null,
          pluginType: r.pluginType,
          catalogServerId: r.catalogServerId ?? null,
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
        denylist: denylistRows.map((r) => ({
          id: r.id,
          publicId: r.publicId,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
          createdByUserId: r.createdByUserId ?? null,
          updatedByUserId: r.updatedByUserId ?? null,
          orgId: r.orgId,
          pluginType: r.pluginType,
          serverName: r.serverName,
          reason: r.reason ?? null,
        })),
      };
    });
  } catch (err) {
    logger.error({ err, orgId }, "plugin.org.list: failed");
    throw err;
  }
};
