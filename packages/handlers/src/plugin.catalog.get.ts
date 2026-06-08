import { eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input) => {
  const { catalogId } = input as { catalogId: string };
  let rows: (typeof schema.mcpCatalogServers.$inferSelect)[];
  try {
    rows = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.mcpCatalogServers)
        .where(eq(schema.mcpCatalogServers.id, catalogId))
        .limit(1),
    );
  } catch (err) {
    logger.error({ err, catalogId }, "plugin.catalog.get: query failed");
    throw err;
  }
  const r = rows[0];
  if (!r) throw new Error("catalog server not found");
  logger.info({ catalogId, name: r.name }, "plugin.catalog.get: ok");
  return {
    id: r.id,
    name: r.name,
    title: r.title ?? null,
    description: r.description,
    version: r.version,
    repository: r.repository ?? null,
    websiteUrl: r.websiteUrl ?? null,
    icons: (r.icons as unknown[]) ?? [],
    packages: (r.packages as unknown[]) ?? [],
    remotes: (r.remotes as unknown[]) ?? [],
    transportTypes: r.transportTypes,
    authKind: r.authKind,
    categories: r.categories,
    readmeHtml: r.readmeHtml ?? null,
    status: r.status,
  };
};
