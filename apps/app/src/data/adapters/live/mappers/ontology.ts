// Pure mappers for the live ontology adapter: capability outputs and table rows
// in, the Ontology page's view models (src/data/contracts/ontology.ts) out.
// No I/O and no Next imports, so every branch has a unit test.
//
// Column-level mapping for `sources` (plan §3.1 "Ontology · sources"):
//
//   Source.name        ← list_connections.displayName   (ingestion.source_connections.display_name)
//   Source.kind        ← list_connections.connectorId   (connector_id: github, linear; see SOURCE_KINDS)
//   Source.records     ← list_connections.entityCount   (entity_count: source records landed as entities)
//   Source.lastSyncAt  ← list_connections.lastSyncAt    (last_sync_at; null never synced → unrepresentable)
//   Source.health      ← list_connections.status + healthStatus (status, health_status)
//   Source.cursor      ← source_connections.cursor      (jsonb { [recordType]: watermark }; no capability exposes it)
//   Source.entities    ← get_connection_mappings.mappings[isActive].oxagenEntityType
//                                                         (ingestion.entity_type_mappings)
import type { ConnectionListOutput } from "@oxagen/oxagen/contracts/connection.list";
import type { ConnectionMappingsGetOutput } from "@oxagen/oxagen/contracts/connection.mappings.get";
import type { schema } from "@oxagen/database";
import type { Source, SyncHealth } from "@/data/contracts";

export type ConnectionRow = ConnectionListOutput["connections"][number];
export type MappingRow = ConnectionMappingsGetOutput["mappings"][number];
/** The one `ingestion.source_connections` column no capability returns. */
export type CursorRow = Pick<
  typeof schema.sourceConnections.$inferSelect,
  "id" | "cursor"
>;

/**
 * Connector id → the spec's source kinds (spec §2.1: GitHub, Linear, Postgres).
 * No Postgres connector exists today (`custom-sql` is a generic SQL poller, not
 * the §11 schema-reconciling connector), so nothing maps to `postgres` yet. Any
 * other connector is outside the Ontology page's v1 scope and is not listed.
 */
export const SOURCE_KINDS: Readonly<Record<string, Source["kind"]>> = {
  github: "github",
  linear: "linear",
};

/**
 * Lifecycle states that are a source the graph reads from. `pending_setup` has
 * not finished connecting; `deleting` and `deleted` are on their way out.
 */
const SOURCE_STATUSES: ReadonlySet<string> = new Set([
  "connected",
  "paused",
  "error",
]);

/** A connection the Sources tab lists: a v1 kind in a live lifecycle state. */
export function isOntologySource(row: ConnectionRow): boolean {
  return (
    SOURCE_STATUSES.has(row.status) &&
    Object.hasOwn(SOURCE_KINDS, row.connectorId)
  );
}

const HEALTH: Readonly<Record<ConnectionRow["healthStatus"], SyncHealth>> = {
  healthy: "ok",
  degraded: "degraded",
  errored: "failed",
};

/**
 * Sync health. A connection in `error` status is failed whatever its last poll
 * rolled up to: reporting it `ok` would read stronger than what was recorded.
 */
export function toSyncHealth(
  status: string,
  healthStatus: ConnectionRow["healthStatus"],
): SyncHealth {
  return status === "error" ? "failed" : HEALTH[healthStatus];
}

/**
 * The incremental cursor as one line: each record type's watermark, record
 * types sorted, `issue 2026-09-11T07:29:00Z · pull_request 2026-09-11T07:31:00Z`.
 * A connection that has not advanced a cursor yet has none: the empty string.
 */
export function formatCursor(cursor: unknown): string {
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor))
    return "";
  return Object.entries(cursor)
    .filter(([, value]) => value !== null && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([type, value]) =>
        `${type} ${typeof value === "string" ? value : JSON.stringify(value)}`,
    )
    .join(" · ");
}

/** The entity types a connection produces: its active mappings, deduplicated and sorted. */
export function toEntities(mappings: readonly MappingRow[]): string[] {
  return [
    ...new Set(
      mappings.filter((m) => m.isActive).map((m) => m.oxagenEntityType),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

export type SourceMapping =
  | { ok: true; source: Source }
  /** A recorded row the view model cannot express without inventing a value. */
  | { ok: false; unrecorded: "lastSyncAt" | "kind" };

/**
 * One Sources row. The caller parses the result with the `Source` schema.
 * Returns `unrecorded` rather than a placeholder when the view model requires
 * a value the store does not hold (a source that has never synced has no
 * `lastSyncAt`, and `Source.lastSyncAt` is not nullable).
 */
export function toSource(input: {
  connection: ConnectionRow;
  mappings: readonly MappingRow[];
  cursor: unknown;
}): SourceMapping {
  const { connection, mappings, cursor } = input;
  // hasOwn, not a bare index: `toString` or `__proto__` as a connector id
  // would otherwise read Object.prototype.
  if (!Object.hasOwn(SOURCE_KINDS, connection.connectorId))
    return { ok: false, unrecorded: "kind" };
  const kind = SOURCE_KINDS[connection.connectorId] as Source["kind"];
  if (connection.lastSyncAt === null)
    return { ok: false, unrecorded: "lastSyncAt" };
  return {
    ok: true,
    source: {
      name: connection.displayName,
      kind,
      records: connection.entityCount,
      lastSyncAt: connection.lastSyncAt,
      health: toSyncHealth(connection.status, connection.healthStatus),
      cursor: formatCursor(cursor),
      entities: toEntities(mappings),
    },
  };
}
