// Platform Storage Ontology (PSO) — Phase 1 manifest types.
//
// A deterministic, content-addressed self-model of where every domain's data
// lives across the four stores (Postgres, ClickHouse, Neo4j, blob) plus the
// capabilities that operate on each table. See ADR-031. This file defines the
// serialized shape; the generator in ./generate.ts assembles it and
// ./canonical-json.ts renders it to byte-stable JSON + a sha256 content hash.
//
// Determinism is a hard requirement: no timestamps, stable key ordering, and
// the same committed inputs must always produce byte-identical output. The
// contentHash is a sha256 over the canonical JSON body with the hash field
// itself excluded.

/** The four storage backends the platform spans. */
export type StoreKind = "postgres" | "clickhouse" | "neo4j" | "blob";

/**
 * A single column of a Postgres or ClickHouse table. `type` is the store's own
 * SQL/DDL type string (e.g. "uuid", "LowCardinality(String)") verbatim, so the
 * manifest never lossily normalizes across stores.
 */
export interface ManifestColumn {
  name: string;
  type: string;
  nullable: boolean;
  /**
   * True when this column is declared a primary key on the column itself.
   * INCOMPLETE for Postgres: a composite PK declared in the table's extra
   * config (`primaryKey({ columns: [...] })`) is invisible to Drizzle's
   * per-column `primary` flag, so every column of such a table reports false —
   * security.security_events and ratelimit.rate_limit_counters both look
   * PK-less in the manifest today. Always false for ClickHouse (the ORDER BY
   * key is in `meta.orderBy` instead).
   */
  primaryKey: boolean;
  /** Present only for Postgres columns that carry a foreign-key reference. */
  references?: string; // a table id, e.g. "postgres:agent.agent_executions"
}

/**
 * The RLS policy class for a tenant-owned Postgres table, mirrored verbatim
 * from packages/database/src/tenant-policy.manifest.ts. Absent for tables that
 * are not tenant-scoped (shared catalogs, ClickHouse/Neo4j/blob entries).
 */
export type RlsPolicyClass =
  | "standard"
  | "workspace_nullable"
  | "org_only"
  | "workspace_only"
  | "org_or_global"
  | "standard_or_builtin";

/** A single table (Postgres/ClickHouse) or node label (Neo4j) / asset kind (blob). */
export interface ManifestTable {
  /** Globally unique, store-qualified id, e.g. "postgres:billing.invoices". */
  id: string;
  store: StoreKind;
  /** The platform domain this table belongs to (see domains.ts). */
  domain: string;
  /** The table/label/asset-kind name within its store. */
  name: string;
  /**
   * True when the table's rows are isolated per tenant (org/workspace). For
   * Postgres this is derived from the tenant-policy manifest membership; for
   * other stores from the known scoping property (e.g. Neo4j orgId index).
   *
   * Reliable only in the true direction. A false is not proof a table is
   * un-scoped: the Neo4j source flags a label only when an index or constraint
   * names `orgId`, so a workspace-only-indexed label such as :EntityNode
   * reports false despite being tenant-owned. Do not use a false value as
   * evidence in a tenancy audit without checking the store's own DDL.
   */
  tenantScoped: boolean;
  /** RLS policy class for tenant-scoped Postgres tables; absent otherwise. */
  rls?: RlsPolicyClass;
  columns: ManifestColumn[];
  /**
   * Store-specific structural metadata that does not fit the column model:
   * ClickHouse engine/TTL/order-by, Neo4j indexes/constraints, blob driver +
   * referencing tables. Kept as a sorted string→string map so it stays
   * canonical and store-agnostic in the top-level shape.
   */
  meta?: Record<string, string>;
}

/** A storage backend and the domains/tables it holds. */
export interface ManifestStore {
  kind: StoreKind;
  /** Human description of what this store is for (four-store boundary). */
  purpose: string;
  /** Domains that have at least one table in this store, sorted. */
  domains: string[];
  /** Count of tables this store holds. */
  tableCount: number;
}

/** A platform domain and the stores/tables that realize it. */
export interface ManifestDomain {
  name: string;
  /** Stores this domain has tables in, sorted. */
  stores: StoreKind[];
  /** Table ids belonging to this domain, sorted. */
  tables: string[];
}

/**
 * A capability and the tables it reads/writes. reads/writes are BEST-EFFORT,
 * derived from the contract's produces/consumes data tags via an explicit
 * tag→table map (see sources/capabilities.ts). Where a tag has no known table
 * mapping the arrays stay empty — the generator never guesses a mapping. Later
 * PSO phases add handler-body scanning to populate these fully.
 */
export interface ManifestCapability {
  name: string;
  domain: string;
  /** Surfaces the capability is exposed on (api/mcp/agent/cli), sorted. */
  surfaces: string[];
  /** Table ids this capability reads from (best-effort), sorted. */
  reads: string[];
  /** Table ids this capability writes to (best-effort), sorted. */
  writes: string[];
}

/** The full Platform Storage Ontology manifest, Phase 1. */
export interface StorageManifest {
  /** Manifest schema version — bump on any breaking shape change. */
  version: number;
  /** sha256 of the canonical JSON body with this field excluded. */
  contentHash: string;
  stores: ManifestStore[];
  domains: ManifestDomain[];
  tables: ManifestTable[];
  capabilities: ManifestCapability[];
}
