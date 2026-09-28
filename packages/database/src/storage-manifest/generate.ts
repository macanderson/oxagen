// generate.ts — assemble the full Platform Storage Ontology manifest.
//
// Pulls every store's tables + the capability registry and derives the domain
// and store cross-views. Deterministic end to end: every source sorts its
// output and the assembler sorts every aggregate, so identical committed inputs
// always yield a byte-identical manifest (canonical-json.ts guarantees the
// serialization is order-independent too).
//
// The committed manifest holds no value derived from the whole table or
// capability set (ADR-214). It once carried a `contentHash` over its body and a
// `tableCount` per store. Every branch that added a table or a capability
// rewrote those lines, so any two such branches conflicted by construction,
// and keeping one side's value left a manifest that disagreed with its own
// body (#3691, #3233). `manifestSummary` and `contentHashOf` compute both at
// read time instead.

import { canonicalJson } from "./canonical-json";
import type {
  ManifestCapability,
  ManifestDomain,
  ManifestStore,
  ManifestTable,
  StorageManifest,
  StoreKind,
} from "./types";
import { collectPostgresTables } from "./sources/postgres";
import { collectClickhouseTables } from "./sources/clickhouse";
import { collectNeo4jLabels } from "./sources/neo4j";
import { collectBlobAssets } from "./sources/blob";
import { collectCapabilities } from "./sources/capabilities";

/**
 * Current manifest schema version. Bump on any breaking shape change.
 * 2: `contentHash` and `stores[].tableCount` left the committed shape
 * (ADR-214).
 */
export const MANIFEST_VERSION = 2;

const STORE_ORDER: readonly StoreKind[] = [
  "postgres",
  "clickhouse",
  "neo4j",
  "blob",
];

const STORE_PURPOSE: Record<StoreKind, string> = {
  postgres:
    "Transactional state — users, orgs, permissions, billing, configs, durable application state.",
  clickhouse:
    "Append-only runtime events — execution events, logs, metrics, traces, token analytics, telemetry.",
  neo4j:
    "Graph data — ontology/entity relationships, workflow lineage, agent memory, semantic retrieval.",
  blob: "Binary assets — avatars, generated media, uploads; the Postgres row (URL + metadata) is source of truth.",
};

/** Collect every store's tables into one sorted list (id-ordered). */
function collectAllTables(): ManifestTable[] {
  const tables = [
    ...collectPostgresTables(),
    ...collectClickhouseTables(),
    ...collectNeo4jLabels(),
    ...collectBlobAssets(),
  ];
  tables.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return tables;
}

/**
 * Build the per-store cross-view from the flat table list. No table count: it
 * is `tables.filter(t => t.store === kind).length`, and a committed copy of it
 * is a line every table-adding branch rewrites (ADR-214).
 */
function buildStores(tables: ManifestTable[]): ManifestStore[] {
  return STORE_ORDER.map((kind) => {
    const forStore = tables.filter((t) => t.store === kind);
    const domains = [...new Set(forStore.map((t) => t.domain))].sort();
    return {
      kind,
      purpose: STORE_PURPOSE[kind],
      domains,
    };
  });
}

/** Build the per-domain cross-view from the flat table list. */
function buildDomains(tables: ManifestTable[]): ManifestDomain[] {
  const byDomain = new Map<string, ManifestTable[]>();
  for (const t of tables) {
    const arr = byDomain.get(t.domain) ?? [];
    arr.push(t);
    byDomain.set(t.domain, arr);
  }
  const domains: ManifestDomain[] = [...byDomain.entries()].map(
    ([name, ts]) => ({
      name,
      stores: [...new Set(ts.map((t) => t.store))].sort() as StoreKind[],
      tables: ts.map((t) => t.id).sort(),
    }),
  );
  domains.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return domains;
}

/**
 * Assemble a manifest from its tables and capabilities. Pure: the same inputs
 * in any order give the same canonical bytes. Split from `buildManifest` so a
 * test can assemble synthetic inputs, and merge two branches of the result.
 */
export function assembleManifest(
  tables: readonly ManifestTable[],
  capabilities: readonly ManifestCapability[],
): StorageManifest {
  const sortedTables = [...tables].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const sortedCapabilities = [...capabilities].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return {
    version: MANIFEST_VERSION,
    stores: buildStores(sortedTables),
    domains: buildDomains(sortedTables),
    tables: sortedTables,
    capabilities: sortedCapabilities,
  };
}

/**
 * Build the complete storage manifest from the committed sources. Pure over
 * the committed inputs — no timestamps, no environment reads.
 */
export function buildManifest(): StorageManifest {
  return assembleManifest(collectAllTables(), collectCapabilities());
}

/** Build the manifest and render it to canonical JSON text (committed form). */
export function renderManifest(): string {
  return canonicalJson(buildManifest());
}

/** Small summary counts for CLI output + tests. */
export function manifestSummary(manifest: StorageManifest): {
  domains: number;
  tables: number;
  stores: number;
  capabilities: number;
  tablesByStore: Record<string, number>;
} {
  // Counted from the tables at read time; the manifest does not commit them.
  const tablesByStore: Record<string, number> = {};
  for (const s of manifest.stores) {
    tablesByStore[s.kind] = manifest.tables.filter(
      (t) => t.store === s.kind,
    ).length;
  }
  return {
    domains: manifest.domains.length,
    tables: manifest.tables.length,
    stores: manifest.stores.length,
    capabilities: manifest.capabilities.length,
    tablesByStore,
  };
}
