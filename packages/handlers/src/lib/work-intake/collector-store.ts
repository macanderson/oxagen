// collector-store.ts: the Postgres CollectorStore the collector pipeline
// (@oxagen/ingestion/collectors pipeline.ts) reads and writes through, bound
// to one org and workspace (P1-03, #5103).
//
// Every call opens its own tenant transaction (withTenantDb), so the caller
// must run inside runInTenantScope for the same org and workspace. Row
// security fences every read and write, and every query also names the org
// and workspace.
//
// An item write stores the source columns (items.ts) and records the material
// fields with the P1-02 store's recordSource in one transaction, so a new
// issue is a `collected` fact and a changed subject, description, or label set
// is a `source_changed` fact on the next item revision (ADR-244).
import { schema, withTenantDb } from "@oxagen/database";
import type {
  CollectorCloudEvent,
  CollectorHealth,
  CollectorRecord,
  CollectorStore,
  CollectorType,
  InboundEventRecord,
  NewInboundEvent,
  StoredWorkItem,
  WorkItemInput,
} from "@oxagen/ingestion/collectors";
import { and, desc, eq, inArray, isNull, like, ne, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { recordSource, type WorkScope } from "../work-records/store";
import { findProviderItem, sourceDedupeKey, upsertProviderItem } from "./items";

const collectors = schema.workCollectors;
const events = schema.workInboundEvents;
const items = schema.workItems;

/** The delivery id prefixes of a collector's result rows (pipeline.ts). */
const RESULT_PREFIX = { reconcile: "reconcile:", count: "count:" } as const;

function toCollector(row: typeof collectors.$inferSelect): CollectorRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    name: row.name,
    type: row.type as CollectorType,
    connectionId: row.connectionId,
    scope: row.scope,
    health: row.health as CollectorHealth,
    cursor: row.cursor,
    createdAt: row.createdAt.toISOString(),
  };
}

function toEvent(row: typeof events.$inferSelect): InboundEventRecord {
  return {
    id: row.id,
    collectorId: row.collectorId,
    deliveryId: row.deliveryId,
    cloudevent: row.cloudevent as unknown as CollectorCloudEvent,
    rawRef: row.rawRef,
    processedAt: row.processedAt === null ? null : row.processedAt.toISOString(),
    outcome: row.outcome,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The repositories a GitHub collector's scope names, lowercased. Empty for any other scope. */
export function scopeRepos(scope: Record<string, unknown>): string[] {
  const repos = scope.repos;
  if (!Array.isArray(repos)) return [];
  return repos.filter((repo): repo is string => typeof repo === "string").map((repo) => repo.toLowerCase());
}

/** The Postgres store for one org and workspace. Call it inside runInTenantScope for that scope. */
export function postgresCollectorStore(scope: WorkScope, now: () => Date = () => new Date()): CollectorStore {
  const inScope = (table: { orgId: AnyPgColumn; workspaceId: AnyPgColumn }) =>
    and(eq(table.orgId, scope.orgId), eq(table.workspaceId, scope.workspaceId));

  return {
    async getCollector(id) {
      const [row] = await withTenantDb((tx) =>
        tx.select().from(collectors).where(and(eq(collectors.id, id), inScope(collectors))).limit(1),
      );
      return row ? toCollector(row) : null;
    },

    async hasDelivery(collectorId, deliveryId) {
      const [row] = await withTenantDb((tx) =>
        tx
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.collectorId, collectorId), eq(events.deliveryId, deliveryId), inScope(events)))
          .limit(1),
      );
      return row !== undefined;
    },

    async insertInboundEvent(row: NewInboundEvent) {
      const [inserted] = await withTenantDb((tx) =>
        tx
          .insert(events)
          .values({
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            collectorId: row.collectorId,
            deliveryId: row.deliveryId,
            cloudevent: row.cloudevent as unknown as Record<string, unknown>,
            rawRef: row.rawRef,
            processedAt: row.processedAt === null ? null : new Date(row.processedAt),
            outcome: row.outcome,
          })
          .onConflictDoNothing({ target: [events.collectorId, events.deliveryId] })
          .returning(),
      );
      return inserted ? toEvent(inserted) : null;
    },

    async getInboundEvent(id) {
      const [row] = await withTenantDb((tx) =>
        tx.select().from(events).where(and(eq(events.id, id), inScope(events))).limit(1),
      );
      return row ? toEvent(row) : null;
    },

    async markInboundEvent(id, outcome) {
      await withTenantDb((tx) =>
        tx
          .update(events)
          .set({ processedAt: now(), outcome })
          .where(and(eq(events.id, id), inScope(events))),
      );
    },

    async findItem(_collectorId, providerId): Promise<StoredWorkItem | null> {
      return withTenantDb((tx) => findProviderItem(tx, scope, providerId));
    },

    async upsertItem(collector: CollectorRecord, input: WorkItemInput) {
      return withTenantDb(async (tx) => {
        const written = await upsertProviderItem(tx, scope, collector.id, input);
        const material = { subject: input.subject, description: input.description, labels: input.labels };
        const occurredAt = input.sourceUpdatedAt ?? now().toISOString();
        await recordSource(tx, scope, {
          itemId: written.after.id,
          material,
          source: "provider",
          actor: `collector:${collector.name}`,
          occurredAt,
          dedupeKey: sourceDedupeKey(material, occurredAt),
        });
        return { item: written.after, created: written.created };
      });
    },

    async setCursor(collectorId, cursor) {
      await withTenantDb((tx) =>
        tx
          .update(collectors)
          .set({ cursor, updatedAt: now() })
          .where(and(eq(collectors.id, collectorId), inScope(collectors))),
      );
    },

    async setHealth(collectorId, health) {
      await withTenantDb((tx) =>
        tx
          .update(collectors)
          .set({ health, updatedAt: now() })
          .where(and(eq(collectors.id, collectorId), inScope(collectors))),
      );
    },

    async listResults(collectorId, kind, limit) {
      const rows = await withTenantDb((tx) =>
        tx
          .select()
          .from(events)
          .where(and(eq(events.collectorId, collectorId), like(events.deliveryId, `${RESULT_PREFIX[kind]}%`), inScope(events)))
          .orderBy(desc(events.createdAt))
          .limit(limit),
      );
      return rows.map(toEvent);
    },

    async countOpenItems(collectorId) {
      // An item the workspace already held from another collector is not
      // stored twice, so a collector counts the open items in the
      // repositories it names as well as the ones it stored itself.
      return withTenantDb(async (tx) => {
        const [collector] = await tx
          .select({ scope: collectors.scope })
          .from(collectors)
          .where(and(eq(collectors.id, collectorId), inScope(collectors)))
          .limit(1);
        const repos = collector ? scopeRepos(collector.scope) : [];
        const owned = repos.length > 0
          ? or(eq(items.collectorId, collectorId), inArray(sql`lower(${items.sourceRepository})`, repos))
          : eq(items.collectorId, collectorId);
        const [row] = await tx
          .select({ open: sql<number>`count(*)::int` })
          .from(items)
          .where(
            and(
              inScope(items),
              owned,
              eq(items.origin, "provider"),
              ne(items.statusCategory, "closed"),
              isNull(items.deletedAt),
            ),
          );
        return Number(row?.open ?? 0);
      });
    },
  };
}
