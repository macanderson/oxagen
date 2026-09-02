// Platform Storage Ontology (PSO) — Phase 1 storage-manifest generator.
//
// A deterministic, content-addressed self-model of where every domain's data
// lives across the four stores (Postgres, ClickHouse, Neo4j, blob) plus the
// capabilities that operate on each table. See docs/adr/ADR-031. Run the CLI
// via `pnpm schema:manifest` (write) or `pnpm schema:manifest:check` (drift
// check — a script, not a wired CI gate; see cli.ts).

export * from "./types";
export {
  buildManifest,
  renderManifest,
  manifestSummary,
  MANIFEST_VERSION,
} from "./generate";
export { canonicalJson, canonicalize, contentHashOf } from "./canonical-json";
export { MANIFEST_PATH } from "./cli";
