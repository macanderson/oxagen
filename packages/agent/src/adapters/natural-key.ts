/**
 * `:SourceFile` natural-key derivation — re-exported from the single canonical
 * home in `@oxagen/ontology/natural-key` so the file-lock adapters
 * (`file-lock.ts`, `file-lock-lease.ts`), GitHub ingestion, and run lineage all
 * resolve a file to the SAME node identity
 * (docs/specs/workspace-graph-boundary/spec.md finding 4).
 *
 * Imported via the lightweight `@oxagen/ontology/natural-key` subpath (a pure
 * string module) so a lock on the hot path never drags the neo4j-driver graph.
 */
export { toNaturalKey } from "@oxagen/ontology/natural-key";
