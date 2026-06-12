import { and, desc, eq, ilike, arrayOverlaps, isNull, sql } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { listOxagenPlugins } from "@oxagen/oxagen/plugins";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { search, pluginType, categories, transportTypes, authKind, limit, offset } = input as {
    search?: string;
    pluginType?: "mcp_server" | "integration" | "content_tool" | "capability";
    categories?: string[];
    transportTypes?: string[];
    authKind?: string;
    limit: number;
    offset: number;
  };

  // ── Capability path ──────────────────────────────────────────────────────────
  // Capability entries come from the static Oxagen plugin registry, NOT from
  // mcp.catalog_servers. They only appear when pluginType is explicitly "capability".
  // An omitted pluginType browses only catalog_servers (existing behaviour preserved).
  if (pluginType === "capability") {
    let manifests = listOxagenPlugins().filter(
      (m) => m.visibility !== "hidden" && m.visibility !== "preview",
    );

    // Apply text search against id, name, and description.
    if (search) {
      const lower = search.toLowerCase();
      manifests = manifests.filter(
        (m) =>
          m.id.toLowerCase().includes(lower) ||
          m.name.toLowerCase().includes(lower) ||
          m.description.toLowerCase().includes(lower),
      );
    }

    const total = manifests.length;
    const page = manifests.slice(offset, offset + limit);

    // Resolve which plugins are already installed for this org.
    const installedNames = await withSystemDb(async (tx) => {
      if (page.length === 0) return new Set<string>();
      const rows = await tx
        .select({ name: schema.pluginOrgListings.name })
        .from(schema.pluginOrgListings)
        .where(
          and(
            eq(schema.pluginOrgListings.orgId, ctx.orgId),
            eq(schema.pluginOrgListings.pluginType, "capability"),
            isNull(schema.pluginOrgListings.deletedAt),
          ),
        );
      return new Set(rows.map((r) => r.name));
    });

    logger.info({ limit, offset, total, orgId: ctx.orgId }, "plugin.catalog.browse capability: ok");

    return {
      servers: page.map((m) => ({
        // name = stable install key (matches org_listings.name = plugin id)
        id: m.id,
        name: m.id,
        title: m.name,
        description: m.description,
        icons: [],
        transportTypes: [],
        authKind: "none",
        categories: [m.category],
        version: m.version,
        pluginType: "capability" as const,
        tier: m.tier,
        installed: installedNames.has(m.id),
      })),
      nextOffset: offset + page.length < total ? offset + limit : null,
      total,
    };
  }

  // ── MCP server / integration / content_tool path (unchanged) ────────────────
  const conds = [
    eq(schema.mcpCatalogServers.isLatest, true),
    eq(schema.mcpCatalogServers.status, "active"),
  ];
  if (search) conds.push(ilike(schema.mcpCatalogServers.name, `%${search}%`));
  if (authKind) conds.push(eq(schema.mcpCatalogServers.authKind, authKind));
  // pluginType is a TYPE discriminator overlaid on the `categories` array, where
  // mcp_server is the DEFAULT classification: a catalog row is an mcp_server
  // unless it is explicitly tagged "integration" or "content_tool". This MUST
  // mirror the output derivation below (serverPluginType) — otherwise a server
  // with empty/content-only categories (the common case: real registry syncs
  // never write the literal "mcp_server" tag) is classified mcp_server on output
  // yet filtered OUT of the mcp_server tab, leaving the marketplace empty.
  if (pluginType === "mcp_server") {
    conds.push(
      sql`NOT (${schema.mcpCatalogServers.categories} && ARRAY['integration','content_tool']::text[])`,
    );
  } else if (pluginType) {
    conds.push(arrayOverlaps(schema.mcpCatalogServers.categories, [pluginType]));
  }
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
        servers: rows.map((r) => {
          // Determine pluginType from categories array
          let serverPluginType: string = "mcp_server";
          if (r.categories?.includes("integration")) serverPluginType = "integration";
          else if (r.categories?.includes("content_tool")) serverPluginType = "content_tool";

          return {
            id: r.id,
            name: r.name,
            title: r.title ?? null,
            description: r.description,
            icons: (r.icons as Array<{ src: string }>) ?? [],
            transportTypes: r.transportTypes,
            authKind: r.authKind,
            categories: r.categories,
            version: r.version,
            pluginType: serverPluginType,
          };
        }),
        nextOffset: offset + rows.length < count ? offset + limit : null,
        total: count,
      };
    });
  } catch (err) {
    logger.error({ err, limit, offset }, "plugin.catalog.browse: failed");
    throw err;
  }
};
