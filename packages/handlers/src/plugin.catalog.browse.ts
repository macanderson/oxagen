import { and, desc, eq, ilike, arrayOverlaps, sql } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input) => {
  const { search, categories, transportTypes, authKind, limit, offset } = input as {
    search?: string;
    categories?: string[];
    transportTypes?: string[];
    authKind?: string;
    limit: number;
    offset: number;
  };
  const conds = [
    eq(schema.mcpCatalogServers.isLatest, true),
    eq(schema.mcpCatalogServers.status, "active"),
  ];
  if (search) conds.push(ilike(schema.mcpCatalogServers.name, `%${search}%`));
  if (authKind) conds.push(eq(schema.mcpCatalogServers.authKind, authKind));
  if (categories?.length) conds.push(arrayOverlaps(schema.mcpCatalogServers.categories, categories));
  if (transportTypes?.length) conds.push(arrayOverlaps(schema.mcpCatalogServers.transportTypes, transportTypes));
  const where = and(...conds);

  try {
    return await withSystemDb(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.mcpCatalogServers)
        .where(where)
        .orderBy(desc(schema.mcpCatalogServers.publishedAt))
        .limit(limit)
        .offset(offset);
      const countRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.mcpCatalogServers)
        .where(where);
      const countRow = countRows[0];
      const count = countRow?.count ?? 0;
      logger.info({ limit, offset, total: count }, "plugin.catalog.browse: ok");
      return {
        servers: rows.map((r) => ({
          id: r.id,
          name: r.name,
          title: r.title ?? null,
          description: r.description,
          icons: (r.icons as Array<{ src: string }>) ?? [],
          transportTypes: r.transportTypes,
          authKind: r.authKind,
          categories: r.categories,
          version: r.version,
        })),
        nextOffset: offset + rows.length < count ? offset + limit : null,
        total: count,
      };
    });
  } catch (err) {
    logger.error({ err, limit, offset }, "plugin.catalog.browse: failed");
    throw err;
  }
};
