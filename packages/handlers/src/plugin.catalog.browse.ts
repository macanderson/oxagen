import { and, eq, isNull, inArray, ilike, or } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { listOxagenPlugins } from "@oxagen/oxagen/plugins";
import {
  listServers,
  mapServerDetailToCatalogRow,
  deriveTransportTypes,
  deriveAuthKind,
} from "@oxagen/plugins/registry";
import type { ServerResponse } from "@oxagen/plugins/registry";
import { seedWorkspaceDefaultRegistry } from "./workspace-registry-seed";
import { logger } from "./logger";

// ── TTL cache for live registry fetches ──────────────────────────────────────
// Module-scope; survives across requests in the same Node.js process. Keyed by
// `${registryId}:${search ?? ""}` so different search queries are cached
// independently. ~60 s TTL keeps the marketplace snappy without stale data risk.
//
// The key embeds a caller-supplied search string, so the key space is unbounded.
// Expired entries are swept on every miss and the map is hard-capped, otherwise
// a long-lived process accumulates one dead entry per distinct search term
// forever.

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;

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

  // Fetch one page per registry; sufficient for an in-memory sort+paginate.
  // The MCP Registry API caps `limit` at 100 (returns 422 for >100), so 100 is the
  // max single-page size. One page is enough for marketplace browsing — search
  // narrows results, and deep paging would use the cursor if ever needed.
  const result = await listServers(baseUrl, { limit: 100, search });
  const now = Date.now();
  // Drop everything already past its TTL — those entries can never be served
  // again, so retaining them is pure leak.
  for (const [k, v] of registryCache) {
    if (v.expiresAt <= now) registryCache.delete(k);
  }
  // Hard ceiling for the pathological case where live entries alone exceed the
  // cap: evict oldest-inserted first (Map preserves insertion order).
  while (registryCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = registryCache.keys().next();
    if (oldest.done) break;
    registryCache.delete(oldest.value);
  }
  const entry: CacheEntry = {
    servers: result.servers,
    expiresAt: now + CACHE_TTL_MS,
  };
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
  const { search, pluginType, authKind, installed, limit, offset } = input as {
    search?: string;
    pluginType?:
      | "mcp_server"
      | "agent_capability"
      | "agent_skill"
      | "knowledge_source"
      | "integration";
    categories?: string[];
    transportTypes?: string[];
    authKind?: string;
    installed?: boolean;
    limit: number;
    offset: number;
  };

  // ── agent_skill path — seeded skills from agent.skills table ────────────────
  // Skills are seeded workspace-wide by db:seed-skills and are always considered
  // installed (they are not tracked in plugin.installed_plugins). Skills are
  // surfaced read-only here; no dual-write to installed_plugins occurs.
  if (pluginType === "agent_skill") {
    let rows = await withTenantDb(async (tx) => {
      if (!ctx.orgId) return [];
      return tx
        .select({
          id: schema.skills.id,
          slug: schema.skills.slug,
          name: schema.skills.name,
          description: schema.skills.description,
          source: schema.skills.source,
        })
        .from(schema.skills)
        .where(
          and(
            eq(schema.skills.orgId, ctx.orgId),
            eq(schema.skills.workspaceId, ctx.workspaceId),
            eq(schema.skills.enabled, true),
            isNull(schema.skills.deletedAt),
          ),
        );
    });

    if (search) {
      const lower = search.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.slug.toLowerCase().includes(lower) ||
          r.name.toLowerCase().includes(lower) ||
          (r.description ?? "").toLowerCase().includes(lower),
      );
    }

    // Skills are installed-by-default; the installed filter is a no-op for
    // installed:false (there are no un-installed skills in this set).
    if (installed === false) {
      rows = [];
    }

    const total = rows.length;
    const page = rows.slice(offset, offset + limit);

    logger.info(
      { limit, offset, total, orgId: ctx.orgId },
      "plugin.catalog.browse agent_skill: ok",
    );

    return {
      servers: page.map((r) => ({
        id: r.id,
        name: r.slug,
        title: r.name,
        description: r.description ?? "",
        icons: [],
        transportTypes: [],
        authKind: "none",
        categories: ["agent_skill"],
        version: "1.0.0",
        pluginType: "agent_skill" as const,
        tier: "free",
        installed: true,
      })),
      nextOffset: offset + page.length < total ? offset + limit : null,
      total,
    };
  }

  // ── Static plugin path (agent_capability / knowledge_source / integration) ───
  if (!pluginType || STATIC_PLUGIN_TYPES.has(pluginType)) {
    let manifests = listOxagenPlugins().filter(
      (m) => m.visibility !== "hidden" && m.visibility !== "preview",
    );

    // When a specific pluginType is requested, we use the manifest category as a
    // proxy until manifests carry an explicit pluginType field. For now all static
    // manifests are agent_capability entries — knowledge sources and integrations
    // will be added as separate manifest categories in a later pass.
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
    const installedNames = await withTenantDb(async (tx) => {
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

    if (installed === true)
      manifests = manifests.filter((m) => installedNames.has(m.id));
    else if (installed === false)
      manifests = manifests.filter((m) => !installedNames.has(m.id));

    const total = manifests.length;
    const page = manifests.slice(offset, offset + limit);

    logger.info(
      { limit, offset, total, orgId: ctx.orgId, pluginType },
      "plugin.catalog.browse static: ok",
    );

    return {
      servers: page.map((m) => ({
        id: m.id,
        name: m.id,
        title: m.name,
        description: m.description,
        // Forward Lucide icon name + hex accent color per the SHARED ICON DATA CONTRACT.
        // UI branches: http(s)/data URI → <Image>; plain string → CapabilityIcon(color).
        icons: m.icon ? [{ src: m.icon, color: m.color }] : [],
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

  // ── MCP server path — local catalog + live fallback ──────────────────────────
  // Priority: read from the locally-synced mcp.catalog_servers table for instant
  // results. If no synced entries exist (first visit), trigger a lazy sync and
  // fall back to a live fetch. Search queries use the local trigram index when
  // the catalog is populated, or fall through to the live API.

  let liveRows: Array<{
    id: string;
    name: string;
    title: string | null;
    description: string;
    icons: Array<{ src: string; color?: string }>;
    transportTypes: string[];
    authKind: string;
    categories: string[];
    version: string;
    pluginType: "mcp_server";
    installed: boolean;
  }> = [];

  const warnings: string[] = [];

  try {
    // Fetch enabled registries for this org+workspace.
    let registries = await withTenantDb((tx) =>
      tx
        .select({
          id: schema.mcpRegistries.id,
          baseUrl: schema.mcpRegistries.baseUrl,
          lastSyncedAt: schema.mcpRegistries.lastSyncedAt,
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

    // Lazy-seed: pre-existing workspaces may not yet have a default registry row.
    if (registries.length === 0 && ctx.orgId) {
      try {
        await seedWorkspaceDefaultRegistry({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
        });
        registries = await withTenantDb((tx) =>
          tx
            .select({
              id: schema.mcpRegistries.id,
              baseUrl: schema.mcpRegistries.baseUrl,
              lastSyncedAt: schema.mcpRegistries.lastSyncedAt,
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
        logger.info(
          { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
          "plugin.catalog.browse: lazy-seeded default registry for pre-existing workspace",
        );
      } catch (seedErr) {
        logger.warn(
          { seedErr, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
          "plugin.catalog.browse: lazy registry seed failed, proceeding with empty registry list",
        );
        warnings.push(
          "Default MCP registry could not be seeded for this workspace.",
        );
      }
    }

    const registryIds = registries.map((r) => r.id);

    // ── Try local catalog first ───────────────────────────────────────────────
    // Query mcp.catalog_servers for the workspace's registries. This is instant
    // (indexed) and works offline / when the upstream registry is slow.
    if (registryIds.length > 0) {
      const catalogConditions = [
        inArray(schema.mcpCatalogServers.registryId, registryIds),
        eq(schema.mcpCatalogServers.isLatest, true),
      ];

      // Apply text search via trigram ILIKE when search is provided.
      if (search) {
        catalogConditions.push(
          or(
            ilike(schema.mcpCatalogServers.name, `%${search}%`),
            ilike(schema.mcpCatalogServers.title, `%${search}%`),
            ilike(schema.mcpCatalogServers.description, `%${search}%`),
          )!,
        );
      }

      // Apply authKind filter.
      if (authKind) {
        catalogConditions.push(eq(schema.mcpCatalogServers.authKind, authKind));
      }

      const catalogRows = await withTenantDb(
        (tx) =>
          tx
            .select({
              id: schema.mcpCatalogServers.id,
              registryId: schema.mcpCatalogServers.registryId,
              name: schema.mcpCatalogServers.name,
              title: schema.mcpCatalogServers.title,
              description: schema.mcpCatalogServers.description,
              icons: schema.mcpCatalogServers.icons,
              transportTypes: schema.mcpCatalogServers.transportTypes,
              authKind: schema.mcpCatalogServers.authKind,
              version: schema.mcpCatalogServers.version,
            })
            .from(schema.mcpCatalogServers)
            .where(and(...catalogConditions))
            .orderBy(schema.mcpCatalogServers.name)
            .limit(limit + offset + 1), // fetch one extra to detect more pages
      );

      if (catalogRows.length > 0) {
        // Catalog has data — use it as the primary source.
        const seen = new Set<string>();
        for (const row of catalogRows) {
          if (seen.has(row.name)) continue;
          seen.add(row.name);
          liveRows.push({
            id: `${row.registryId}:${row.name}:${row.version}`,
            name: row.name,
            title: row.title,
            description: row.description,
            icons: (row.icons ?? []) as Array<{ src: string; color?: string }>,
            transportTypes: (row.transportTypes ?? []) as string[],
            authKind: (row.authKind ?? "none") as string,
            categories: [],
            version: row.version,
            pluginType: "mcp_server" as const,
            installed: false,
          });
        }
      } else {
        // Catalog is empty — either never synced or search has no results.
        // If never synced, trigger a lazy sync in the background and fall back
        // to the live fetch for this request.
        const neverSynced = registries.some((r) => !r.lastSyncedAt);

        if (neverSynced) {
          // Fire-and-forget: trigger sync so next request is instant.
          import("@oxagen/plugins/catalog-sync").then(({ syncAllRegistries }) =>
            syncAllRegistries({
              orgId: ctx.orgId,
              workspaceId: ctx.workspaceId,
              fullSync: true,
            }).catch((err) => logger.warn({ err }, "lazy catalog sync failed")),
          );
        }

        // Fall back to live fetch for this request.
        const seen = new Set<string>();
        for (const reg of registries) {
          let servers: ServerResponse[];
          try {
            servers = await fetchRegistryServers(reg.id, reg.baseUrl, search);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(
              { err, registryId: reg.id },
              "plugin.catalog.browse: registry fetch failed, skipping",
            );
            warnings.push(
              `Registry ${reg.id} (${reg.baseUrl}) skipped: ${msg}`,
            );
            continue;
          }

          for (const s of servers) {
            if (seen.has(s.server.name)) continue;
            seen.add(s.server.name);

            const mapped = mapServerDetailToCatalogRow(
              s.server,
              s._meta,
              reg.id,
            );
            if (authKind && mapped.authKind !== authKind) continue;

            liveRows.push({
              id: `${reg.id}:${s.server.name}:${s.server.version}`,
              name: s.server.name,
              title: mapped.title,
              description: mapped.description,
              icons: mapped.icons as Array<{ src: string; color?: string }>,
              transportTypes: deriveTransportTypes(s.server),
              authKind: deriveAuthKind(s.server),
              categories: [],
              version: mapped.version,
              pluginType: "mcp_server" as const,
              installed: false,
            });
          }
        }
      }
    }

    // Overlay install state from plugin.installed_plugins.
    if (ctx.orgId && liveRows.length > 0) {
      const installedRows = await withTenantDb((tx) =>
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
      else if (installed === false)
        liveRows = liveRows.filter((r) => !r.installed);
    } else if (installed === true) {
      // No org context — nothing is installed.
      liveRows = [];
    }

    const total = liveRows.length;
    const page = liveRows.slice(offset, offset + limit);

    logger.info(
      { limit, offset, total, registryCount: registries.length },
      "plugin.catalog.browse mcp_server: ok",
    );

    return {
      servers: page,
      nextOffset: offset + page.length < total ? offset + limit : null,
      total,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (err) {
    logger.error({ err, limit, offset }, "plugin.catalog.browse: failed");
    throw err;
  }
};
