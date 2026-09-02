import { or, eq } from "drizzle-orm";
import { schema } from "@oxagen/database";
import { platformVersion } from "@oxagen/config";
import { loadBuiltInSchema } from "@oxagen/ingestion/connector-schema-loader";

/**
 * Shared connection/integration status + versioning helpers.
 *
 * The repo.* and integration.* capabilities operate on the same physical
 * record — `ingestion.source_connections` — but the contracts expose a
 * narrower status vocabulary than the DB CHECK constraint. Centralizing the
 * two translations here keeps repo.metrics / integration.metrics /
 * integration.list / integration.get from each carrying their own (drift-prone)
 * copy of the mapping.
 *
 * DB CHECK constraint (ingestion.source_connections.status):
 *   'pending_setup' | 'connected' | 'paused' | 'error' | 'deleting' | 'deleted'
 *
 * Contract status (repo.metrics / integration.* outputs and filters):
 *   'pending_setup' | 'active' | 'paused' | 'failed'
 */

export type ContractConnectionStatus =
  | "pending_setup"
  | "active"
  | "paused"
  | "failed";

/**
 * DB status → contract status. `deleting`/`deleted` collapse to `pending_setup`
 * because a connection mid-deletion has no live data to report on and the
 * contract has no terminal "deleted" state.
 */
export const DB_STATUS_TO_CONTRACT_STATUS: Record<
  string,
  ContractConnectionStatus
> = {
  pending_setup: "pending_setup",
  connected: "active",
  paused: "paused",
  error: "failed",
  deleting: "pending_setup",
  deleted: "pending_setup",
};

/**
 * Contract status → DB status, used to translate a caller's `status` list
 * filter into the value actually stored on the row. `active` maps to the DB's
 * `connected` (the GitHub-connector live state — see CLAUDE.md / memory: writing
 * `active` silently fails the CHECK constraint).
 */
export const CONTRACT_STATUS_TO_DB_STATUS: Record<
  ContractConnectionStatus,
  string
> = {
  active: "connected",
  paused: "paused",
  failed: "error",
  pending_setup: "pending_setup",
};

export function toContractStatus(dbStatus: string): ContractConnectionStatus {
  return DB_STATUS_TO_CONTRACT_STATUS[dbStatus] ?? "pending_setup";
}

/**
 * Resolve the version string for a connector/integration instance.
 *
 * Built-in connectors declare a real `metadata.version` in their bundled schema
 * YAML (loaded by @oxagen/ingestion/connector-schema-loader), so that is the
 * authoritative version when available. Connectors without a bundled schema
 * fall back to the live platform version (the release tag synced into
 * PLATFORM_VERSION) — first-party connectors ship with the platform — rather
 * than a hardcoded "1.0.0" string scattered across handlers.
 */
export function resolveConnectorVersion(connectorId?: string): string {
  if (connectorId) {
    const loaded = loadBuiltInSchema(connectorId);
    if (loaded?.metadata.version) return loaded.metadata.version;
  }
  return platformVersion();
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The repo.* contracts accept a repoId that may be EITHER the public ID
 * (prefix `con_`) or the raw UUID primary key. `source_connections.id` is a
 * uuid column, so matching it against a non-UUID string would make Postgres
 * throw on the cast — only include the id predicate when the ref is actually a
 * UUID. integration.* inputs are always public IDs, so they keep the simpler
 * publicId-only predicate at their call sites.
 */
export function sourceConnectionRefCondition(ref: string) {
  return UUID_RE.test(ref)
    ? or(
        eq(schema.sourceConnections.publicId, ref),
        eq(schema.sourceConnections.id, ref),
      )
    : eq(schema.sourceConnections.publicId, ref);
}
