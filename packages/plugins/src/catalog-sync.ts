/**
 * plugin.catalog.sync — Fetches all pages from the upstream MCP registry and
 * upserts into mcp.catalog_servers.
 *
 * "Incremental" here means RESUME, not delta. The stored cursor is only
 * non-null when a run stopped at the maxPages cap; a run that reaches the end
 * of the registry clears it, so the next run re-reads every page from the
 * start. The client's `updatedSince` filter — the actual delta mechanism — is
 * not wired up here.
 *
 * Called by:
 *   1. The plugin.catalog-sync Inngest cron (every 6 hours)
 *   2. The plugin.catalog.sync capability (on-demand refresh button)
 *   3. Lazily by plugin.catalog.browse when the table is empty for a registry
 *
 * Design:
 *   - Pages through the entire registry using cursor pagination (limit=100/page)
 *   - Upserts each server entry on the (registry_id, name, version) unique key
 *   - Updates is_latest flag based on registry _meta.isLatest
 *   - Updates the registry row's last_synced_at + last_synced_cursor on completion
 *   - Isolated per-registry: a failing registry doesn't block others
 */
import { eq, and, sql } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
// NOTE: this is a package SELF-reference ("@oxagen/plugins" importing its own
// "./registry" export), not a cross-package import. It works because the export
// map declares the subpath, but it can resolve to a second copy of the registry
// module under some bundler/test resolvers. catalog-sync.test.ts currently
// mocks this exact specifier, so switching to a relative "./registry/index"
// requires updating that mock in the same change.
import {
  listServers,
  deriveTransportTypes,
  deriveAuthKind,
} from "@oxagen/plugins/registry";
import type { ServerResponse } from "@oxagen/plugins/registry";
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "sync_plugin_catalog" },
});

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SyncRegistryOptions {
  registryId: string;
  baseUrl: string;
  /** Resume from this cursor (set only when a prior run hit maxPages). Null = start from the first page. */
  cursor?: string | null;
  /** Max pages to fetch in one sync run (safety valve). Default: 50 (5000 entries). */
  maxPages?: number;
}

export interface SyncResult {
  registryId: string;
  pagesProcessed: number;
  entriesUpserted: number;
  finalCursor: string | null;
  durationMs: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Extract the flat meta fields from the nested _meta structure.
 * The upstream registry wraps meta under a namespaced key like
 * "io.modelcontextprotocol.registry/official".
 */
function extractMeta(raw: ServerResponse["_meta"]): {
  status: string;
  isLatest: boolean;
  publishedAt: string | undefined;
  updatedAt: string | undefined;
} {
  if (!raw)
    return {
      status: "active",
      isLatest: false,
      publishedAt: undefined,
      updatedAt: undefined,
    };

  // Check for the well-known namespaced key first
  const namespaced = (raw as Record<string, unknown>)[
    "io.modelcontextprotocol.registry/official"
  ] as Record<string, unknown> | undefined;

  if (namespaced) {
    return {
      status: (namespaced["status"] as string) ?? "active",
      isLatest: (namespaced["isLatest"] as boolean) ?? false,
      publishedAt: namespaced["publishedAt"] as string | undefined,
      updatedAt: namespaced["updatedAt"] as string | undefined,
    };
  }

  // Fall back to flat structure (in case the API changes)
  return {
    status: ((raw as Record<string, unknown>)["status"] as string) ?? "active",
    isLatest:
      ((raw as Record<string, unknown>)["isLatest"] as boolean) ?? false,
    publishedAt: (raw as Record<string, unknown>)["publishedAt"] as
      | string
      | undefined,
    updatedAt: (raw as Record<string, unknown>)["updatedAt"] as
      | string
      | undefined,
  };
}

// ── Core Sync ─────────────────────────────────────────────────────────────────

/**
 * Sync a single registry: page through all entries and upsert into catalog_servers.
 */
export async function syncRegistry(
  opts: SyncRegistryOptions,
): Promise<SyncResult> {
  const { registryId, baseUrl, maxPages = 50 } = opts;
  const startedAt = Date.now();

  let cursor: string | undefined = opts.cursor ?? undefined;
  let pagesProcessed = 0;
  let entriesUpserted = 0;

  try {
    while (pagesProcessed < maxPages) {
      const result = await listServers(baseUrl, { limit: 100, cursor });
      pagesProcessed++;

      if (result.servers.length === 0) break;

      // Batch upsert this page
      const values = result.servers.map((entry: ServerResponse) => {
        const meta = extractMeta(entry._meta);
        const server = entry.server;
        return {
          registryId,
          name: server.name,
          version: server.version,
          isLatest: meta.isLatest,
          title: server.title ?? null,
          description: server.description,
          icons: (server.icons ?? []) as object,
          packages: (server.packages ?? []) as object,
          remotes: (server.remotes ?? []) as object,
          transportTypes: deriveTransportTypes(server),
          authKind: deriveAuthKind(server),
          repositoryUrl: server.repository?.url ?? null,
          websiteUrl: server.websiteUrl ?? null,
          status: meta.status,
          publishedAt: toDate(meta.publishedAt),
          upstreamUpdatedAt: toDate(meta.updatedAt),
          syncedAt: new Date(),
        };
      });

      await withSystemDb(async (tx) => {
        await tx
          .insert(schema.mcpCatalogServers)
          .values(values)
          .onConflictDoUpdate({
            target: [
              schema.mcpCatalogServers.registryId,
              schema.mcpCatalogServers.name,
              schema.mcpCatalogServers.version,
            ],
            set: {
              isLatest: sql`EXCLUDED.is_latest`,
              title: sql`EXCLUDED.title`,
              description: sql`EXCLUDED.description`,
              icons: sql`EXCLUDED.icons`,
              packages: sql`EXCLUDED.packages`,
              remotes: sql`EXCLUDED.remotes`,
              transportTypes: sql`EXCLUDED.transport_types`,
              authKind: sql`EXCLUDED.auth_kind`,
              repositoryUrl: sql`EXCLUDED.repository_url`,
              websiteUrl: sql`EXCLUDED.website_url`,
              status: sql`EXCLUDED.status`,
              publishedAt: sql`EXCLUDED.published_at`,
              upstreamUpdatedAt: sql`EXCLUDED.upstream_updated_at`,
              syncedAt: sql`EXCLUDED.synced_at`,
              updatedAt: sql`now()`,
            },
          });
      });

      entriesUpserted += values.length;

      // Advance cursor
      if (result.nextCursor) {
        cursor = result.nextCursor;
      } else {
        // No more pages
        cursor = undefined;
        break;
      }
    }

    // Update registry sync state
    const finalCursor = cursor ?? null;
    await withSystemDb(async (tx) => {
      await tx
        .update(schema.mcpRegistries)
        .set({
          lastSyncedAt: new Date(),
          lastSyncedCursor: finalCursor,
        })
        .where(eq(schema.mcpRegistries.id, registryId));
    });

    const durationMs = Date.now() - startedAt;
    logger.info(
      { registryId, pagesProcessed, entriesUpserted, finalCursor, durationMs },
      "catalog sync complete",
    );

    return {
      registryId,
      pagesProcessed,
      entriesUpserted,
      finalCursor,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    logger.error(
      { registryId, baseUrl, pagesProcessed, entriesUpserted, err, durationMs },
      "catalog sync failed",
    );
    throw err;
  }
}

// ── Multi-Registry Sync ───────────────────────────────────────────────────────

export interface SyncAllOptions {
  /** Only sync registries belonging to this org+workspace. If omitted, syncs all enabled registries. */
  orgId?: string;
  workspaceId?: string;
  /** Force a full sync (ignore stored cursor). */
  fullSync?: boolean;
}

export interface SyncAllResult {
  total: number;
  succeeded: number;
  failed: number;
  results: SyncResult[];
  errors: Array<{ registryId: string; error: string }>;
}

/**
 * Sync all enabled registries (or a specific org/workspace's registries).
 * Each registry is synced independently — a single failure doesn't block others.
 */
export async function syncAllRegistries(
  opts: SyncAllOptions = {},
): Promise<SyncAllResult> {
  const conditions = [eq(schema.mcpRegistries.enabled, true)];
  if (opts.orgId) conditions.push(eq(schema.mcpRegistries.orgId, opts.orgId));
  if (opts.workspaceId)
    conditions.push(eq(schema.mcpRegistries.workspaceId, opts.workspaceId));

  const registries = await withSystemDb((tx) =>
    tx
      .select({
        id: schema.mcpRegistries.id,
        baseUrl: schema.mcpRegistries.baseUrl,
        lastSyncedCursor: schema.mcpRegistries.lastSyncedCursor,
      })
      .from(schema.mcpRegistries)
      .where(and(...conditions)),
  );

  const results: SyncResult[] = [];
  const errors: Array<{ registryId: string; error: string }> = [];

  for (const reg of registries) {
    try {
      const result = await syncRegistry({
        registryId: reg.id,
        baseUrl: reg.baseUrl,
        cursor: opts.fullSync ? null : reg.lastSyncedCursor,
      });
      results.push(result);
    } catch (err) {
      errors.push({
        registryId: reg.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    total: registries.length,
    succeeded: results.length,
    failed: errors.length,
    results,
    errors,
  };
}
