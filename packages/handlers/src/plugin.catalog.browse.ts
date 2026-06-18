import { and, eq, isNull } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { listOxagenPlugins } from "@oxagen/oxagen/plugins";
import {
  listServers,
  mapServerDetailToCatalogRow,
  deriveTransportTypes,
  deriveAuthKind,
} from "@oxagen/plugins/registry";
import type { ServerResponse } from "@oxagen/plugins/registry";
import { logger } from "./logger";

// ── TTL cache for live registry fetches ──────────────────────────────────────
// Module-scope; survives across requests in the same Node.js process. Keyed by
// `${registryId}:${search ?? ""}` so different search queries are cached
// independently. ~60 s TTL keeps the marketplace snappy without stale data risk.

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  servers: ServerResponse[];
  expiresAt: number;
}

const registryCache = new Map<string, CacheEntry>();

/** Clear the in-process registry cache. Exported for test isolation. */
export function clearRegistryCacheForTests(): void {
  registryCache.clear();
}

async function fetchRegistryServers(
  registryId: string,
  baseUrl: string,
  search: string | undefined,
): Promise<ServerResponse[]> {
  const key = `${registryId}:${search ?? ""}`;
  const hit = registryCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.servers;

  // Fetch up to 200 results per registry in one page; sufficient for an in-memory
  // sort+paginate. If the registry supports cursor pagination, one page is enough
  // for marketplace browsing — deep paging happens when search narrows results.
  const result = await listServers(baseUrl, { limit: 200, search });
  const entry: CacheEntry = { servers: result.servers, expiresAt: Date.now() + CACHE_TTL_MS };
  registryCache.set(key, entry);
  return result.servers;
}

// ── Static-plugin types (sourced from the Oxagen plugin registry) ─────────────
// agent_capability, agent_skill, knowledge_source, and integration entries all
// come from listOxagenPlugins(); only mcp_server is fetched live from registries.
const STATIC_PLUGIN_TYPES = new Set([
  "agent_capability",
  "agent_skill",
  "knowledge_source",
  "integration",
]);

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const {
    search,
    pluginType,
    authKind,
    installed,
    limit,
    offset,
  } = input as {
    search?: string;
    pluginType?: "mcp_server" | "agent_capability" | "agent_skill" | "knowledge_source" | "integration";
    categories?: string[];
    transportTypes?: string[];
    authKind?: string;
    installed?: boolean;
    limit: number;
    offset: number;
  };

  // ── Static plugin path (agent_capability / agent_skill / knowledge_source / integration) ───
  if (!pluginType || STATIC_PLUGIN_TYPES.has(pluginType)) {
    let manifests = listOxagenPlugins().filter(
      (m) => m.visibility !== "hidden" && m.visibility !== "preview",
    );

    // When a specific pluginType is requested, we use the manifest category as a
    // proxy until manifests carry an explicit pluginType field. For now all static
    // manifests are agent_capability entries — skills, knowledge sources, and
    // integrations will be added as separate manifest categories in a later pass.
    // The filter below is a no-op for "agent_capability" but future-proofs the path.
    if (pluginType && pluginType !== "agent_capability") {
      // No static manifests for other types yet — return empty.
      manifests = [];
    }

    if (search) {
      const lower = search.toLowerCase();
      manifests = manifests.filter(
        (m) =>
          m.id.toLowerCase().includes(lower) ||
          m.name.toLowerCase().includes(lower) ||
          m.description.toLowerCase().includes(lower),
      );
    }

    // Resolve install state from plugin.installed_plugins for (orgId, workspaceId).
    const installedNames = await withSystemDb(async (tx) => {
      if (!ctx.orgId) return new Set<string>();
      const rows = await tx
        .select({ name: schema.pluginInstalledPlugins.name })
        .from(schema.pluginInstalledPlugins)
        .where(
          and(
            eq(schema.pluginInstalledPlugins.orgId, ctx.orgId),
            eq(schema.pluginInstalledPlugins.workspaceId, ctx.workspaceId),
            eq(schema.pluginInstalledPlugins.pluginType, "agent_capability"),
            isNull(schema.pluginInstalledPlugins.deletedAt),
          ),
        );
      return new Set(rows.map((r) => r.name));
    });

    if (installed === true) manifests = manifests.filter((m) => installedNames.has(m.id));
    else if (installed === false) manifests = manifests.filter((m) => !installedNames.has(m.id));

    const total = manifests.length;
    const page = manifests.slice(offset, offset + limit);

    logger.info({ limit, offset, total, orgId: ctx.orgId, pluginType }, "plugin.catalog.browse static: ok");

    return {
      servers: page.map((m) => ({
        id: m.id,
        name: m.id,
        title: m.name,
        description: m.description,
        icons: [],
        transportTypes: [],
        authKind: "none",
        categories: [m.category],
        version: m.version,
        pluginType: "agent_capability" as const,
        tier: m.tier,
        installed: installedNames.has(m.id),
      })),
      nextOffset: offset + page.length < total ? offset + limit : null,
      total,
    };
  }

  // ── MCP server path — live registry fetch ────────────────────────────────────
  // Load the workspace's enabled registries, fetch live from each, merge results,
  // then apply search/authKind/pagination in memory.

  let liveRows: Array<{
    id: string;
    name: string;
    title: string | null;
    description: string;
    icons: Array<{ src: string }>;
    transportTypes: string[];
    authKind: string;
    categories: string[];
    version: string;
    pluginType: "mcp_server";
    installed: boolean;
  }> = [];

  try {
    // Fetch enabled registries for this org+workspace.
    const registries = await withSystemDb((tx) =>
      tx
        .select({
          id: schema.mcpRegistries.id,
          baseUrl: schema.mcpRegistries.baseUrl,
        })
        .from(schema.mcpRegistries)
        .where(
          and(
            eq(schema.mcpRegistries.orgId, ctx.orgId),
            eq(schema.mcpRegistries.workspaceId, ctx.workspaceId),
            eq(schema.mcpRegistries.enabled, true),
          ),
        ),
    );

    // Fetch from each registry (with TTL cache) and map to browse row shape.
    const seen = new Set<string>();
    for (const reg of registries) {
      let servers: ServerResponse[];
      try {
        servers = await fetchRegistryServers(reg.id, reg.baseUrl, search);
      } catch (err) {
        logger.warn({ err, registryId: reg.id }, "plugin.catalog.browse: registry fetch failed, skipping");
        continue;
      }

      for (const s of servers) {
        if (seen.has(s.server.name)) continue; // deduplicate across registries
        seen.add(s.server.name);

        const mapped = mapServerDetailToCatalogRow(s.server, s._meta, reg.id);

        // Apply authKind filter in-memory.
        if (authKind && mapped.authKind !== authKind) continue;

        liveRows.push({
          id: `${reg.id}:${s.server.name}:${s.server.version}`,
          name: s.server.name,
          title: mapped.title,
          description: mapped.description,
          icons: (mapped.icons as Array<{ src: string }>),
          transportTypes: deriveTransportTypes(s.server),
          authKind: deriveAuthKind(s.server),
          categories: [],
          version: mapped.version,
          pluginType: "mcp_server" as const,
          installed: false, // overlaid below
        });
      }
    }

    // Overlay install state from plugin.installed_plugins.
    if (ctx.orgId && liveRows.length > 0) {
      const installedRows = await withSystemDb((tx) =>
        tx
          .select({ name: schema.pluginInstalledPlugins.name })
          .from(schema.pluginInstalledPlugins)
          .where(
            and(
              eq(schema.pluginInstalledPlugins.orgId, ctx.orgId),
              eq(schema.pluginInstalledPlugins.workspaceId, ctx.workspaceId),
              eq(schema.pluginInstalledPlugins.pluginType, "mcp_server"),
              isNull(schema.pluginInstalledPlugins.deletedAt),
            ),
          ),
      );
      const installedNames = new Set(installedRows.map((r) => r.name));
      for (const row of liveRows) {
        row.installed = installedNames.has(row.name);
      }

      // Apply installed filter after overlaying state.
      if (installed === true) liveRows = liveRows.filter((r) => r.installed);
      else if (installed === false) liveRows = liveRows.filter((r) => !r.installed);
    } else if (installed === true) {
      // No org context — nothing is installed.
      liveRows = [];
    }

    const total = liveRows.length;
    const page = liveRows.slice(offset, offset + limit);

    logger.info({ limit, offset, total, registryCount: registries.length }, "plugin.catalog.browse mcp_server: ok");

    return {
      servers: page,
      nextOffset: offset + page.length < total ? offset + limit : null,
      total,
    };
  } catch (err) {
    logger.error({ err, limit, offset }, "plugin.catalog.browse: failed");
    throw err;
  }
};
