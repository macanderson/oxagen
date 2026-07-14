// generate.ts — assemble the full Platform Storage Ontology manifest.
//
// Pulls every store's tables + the capability registry, derives the domain and
// store cross-views, and computes the sha256 content hash over the canonical
// body (hash field excluded). Deterministic end to end: every source sorts its
// output and the assembler sorts every aggregate, so identical committed inputs
// always yield a byte-identical manifest (canonical-json.ts guarantees the
// serialization is order-independent too).

import { canonicalJson, contentHashOf } from "./canonical-json";
import type {
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

/** Current manifest schema version. Bump on any breaking shape change. */
export const MANIFEST_VERSION = 1;

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

/** Build the per-store cross-view from the flat table list. */
function buildStores(tables: ManifestTable[]): ManifestStore[] {
  return STORE_ORDER.map((kind) => {
    const forStore = tables.filter((t) => t.store === kind);
    const domains = [...new Set(forStore.map((t) => t.domain))].sort();
    return {
      kind,
      purpose: STORE_PURPOSE[kind],
      domains,
      tableCount: forStore.length,
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
 * Build the complete storage manifest with a computed content hash. Pure over
 * the committed inputs — no timestamps, no environment reads.
 */
export function buildManifest(): StorageManifest {
  const tables = collectAllTables();
  const stores = buildStores(tables);
  const domains = buildDomains(tables);
  const capabilities = collectCapabilities();

  // Assemble the body WITHOUT the hash, hash it, then stamp the hash in. The
  // hash covers everything else canonically, so it changes iff the content does.
  const body = {
    version: MANIFEST_VERSION,
    stores,
    domains,
    tables,
    capabilities,
  };
  const contentHash = contentHashOf(body);

  return { contentHash, ...body };
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
  const tablesByStore: Record<string, number> = {};
  for (const s of manifest.stores) tablesByStore[s.kind] = s.tableCount;
  return {
    domains: manifest.domains.length,
    tables: manifest.tables.length,
    stores: manifest.stores.length,
    capabilities: manifest.capabilities.length,
    tablesByStore,
  };
}
