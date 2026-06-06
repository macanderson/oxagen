/**
 * Registry → catalog sync. Paginates a registry (cursor), upserts each server
 * version into mcp.catalog_servers (maintaining is_latest), refreshes READMEs
 * respecting a 24h TTL, and checkpoints last_synced_cursor/last_synced_at.
 *
 * Written against a SyncPersistence port for offline unit testing; the default
 * port (createSystemSyncPersistence) is backed by withSystemDb — the catalog is
 * cross-tenant shared state, not org-scoped.
 */
import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { listServers as defaultListServers, type ListServersResult } from "./registry-client";
import { fetchAndRenderReadme as defaultRenderReadme, isReadmeFresh } from "./readme";
import { mapServerDetailToCatalogRow, type CatalogRowInput } from "./map-server";

export interface SyncRegistryRow {
  id: string;
  baseUrl: string;
  lastSyncedAt: Date | null;
}

/** Persistence port — the only DB surface the sync logic touches. */
export interface SyncPersistence {
  getRegistry(registryId: string): Promise<SyncRegistryRow | null>;
  markOthersNotLatest(registryId: string, name: string): Promise<void>;
  /** Upsert by (registry_id, name, version); returns the catalog row id. */
  upsertCatalogRow(row: CatalogRowInput): Promise<string>;
  getReadmeFreshness(catalogId: string): Promise<Date | null>;
  setReadme(catalogId: string, html: string | null, fetchedAt: Date): Promise<void>;
  updateCheckpoint(registryId: string, cursor: string | undefined, at: Date): Promise<void>;
}

export interface SyncDeps {
  listServers: (
    baseUrl: string,
    opts: { cursor?: string; limit?: number; updatedSince?: string },
  ) => Promise<ListServersResult>;
  fetchAndRenderReadme: typeof defaultRenderReadme;
  now: () => number;
}

export interface SyncResult {
  upserted: number;
  readmesRefreshed: number;
}

const PAGE_LIMIT = 100;

export async function syncRegistry(
  registryId: string,
  opts: { mode: "full" | "incremental" },
  persistence: SyncPersistence,
  deps: SyncDeps = {
    listServers: defaultListServers,
    fetchAndRenderReadme: defaultRenderReadme,
    now: () => Date.now(),
  },
): Promise<SyncResult> {
  const registry = await persistence.getRegistry(registryId);
  if (!registry) throw new Error(`registry not found: ${registryId}`);

  const updatedSince =
    opts.mode === "incremental" && registry.lastSyncedAt
      ? registry.lastSyncedAt.toISOString()
      : undefined;

  let cursor: string | undefined;
  let lastCursor: string | undefined;
  let upserted = 0;
  let readmesRefreshed = 0;

  do {
    const page = await deps.listServers(registry.baseUrl, { cursor, limit: PAGE_LIMIT, updatedSince });
    for (const entry of page.servers) {
      const row = mapServerDetailToCatalogRow(entry.server, entry._meta, registryId);
      if (row.isLatest) {
        await persistence.markOthersNotLatest(registryId, row.name);
      }
      const catalogId = await persistence.upsertCatalogRow(row);

      if (row.repository) {
        const freshness = await persistence.getReadmeFreshness(catalogId);
        if (!isReadmeFresh(freshness, deps.now())) {
          const html = await deps.fetchAndRenderReadme(row.repository);
          await persistence.setReadme(catalogId, html, new Date(deps.now()));
          if (html) readmesRefreshed += 1;
        }
      }
      upserted += 1;
    }
    lastCursor = page.nextCursor;
    cursor = page.nextCursor;
  } while (cursor);

  await persistence.updateCheckpoint(registryId, lastCursor, new Date(deps.now()));
  return { upserted, readmesRefreshed };
}

/** Default persistence port backed by withSystemDb (cross-tenant catalog). */
export function createSystemSyncPersistence(): SyncPersistence {
  return {
    async getRegistry(registryId) {
      return withSystemDb(async (tx) => {
        const [r] = await tx
          .select({
            id: schema.mcpRegistries.id,
            baseUrl: schema.mcpRegistries.baseUrl,
            lastSyncedAt: schema.mcpRegistries.lastSyncedAt,
          })
          .from(schema.mcpRegistries)
          .where(eq(schema.mcpRegistries.id, registryId))
          .limit(1);
        return r ?? null;
      });
    },
    async markOthersNotLatest(registryId, name) {
      await withSystemDb(async (tx) => {
        await tx
          .update(schema.mcpCatalogServers)
          .set({ isLatest: false })
          .where(
            and(
              eq(schema.mcpCatalogServers.registryId, registryId),
              eq(schema.mcpCatalogServers.name, name),
            ),
          );
      });
    },
    async upsertCatalogRow(row) {
      return withSystemDb(async (tx) => {
        const [inserted] = await tx
          .insert(schema.mcpCatalogServers)
          .values(row)
          .onConflictDoUpdate({
            target: [
              schema.mcpCatalogServers.registryId,
              schema.mcpCatalogServers.name,
              schema.mcpCatalogServers.version,
            ],
            set: {
              isLatest: row.isLatest,
              title: row.title,
              description: row.description,
              repository: row.repository,
              websiteUrl: row.websiteUrl,
              icons: row.icons,
              packages: row.packages,
              remotes: row.remotes,
              transportTypes: row.transportTypes,
              authKind: row.authKind,
              status: row.status,
              publishedAt: row.publishedAt,
              upstreamUpdatedAt: row.upstreamUpdatedAt,
              statusChangedAt: row.statusChangedAt,
              meta: row.meta,
              updatedAt: new Date(),
            },
          })
          .returning({ id: schema.mcpCatalogServers.id });
        if (!inserted) throw new Error("upsert returned no row");
        return inserted.id;
      });
    },
    async getReadmeFreshness(catalogId) {
      return withSystemDb(async (tx) => {
        const [r] = await tx
          .select({ fetchedAt: schema.mcpCatalogServers.readmeFetchedAt })
          .from(schema.mcpCatalogServers)
          .where(eq(schema.mcpCatalogServers.id, catalogId))
          .limit(1);
        return r?.fetchedAt ?? null;
      });
    },
    async setReadme(catalogId, html, fetchedAt) {
      await withSystemDb(async (tx) => {
        await tx
          .update(schema.mcpCatalogServers)
          .set({ readmeHtml: html, readmeFetchedAt: fetchedAt })
          .where(eq(schema.mcpCatalogServers.id, catalogId));
      });
    },
    async updateCheckpoint(registryId, cursor, at) {
      await withSystemDb(async (tx) => {
        await tx
          .update(schema.mcpRegistries)
          .set({ lastSyncedCursor: cursor ?? null, lastSyncedAt: at })
          .where(eq(schema.mcpRegistries.id, registryId));
      });
    },
  };
}
