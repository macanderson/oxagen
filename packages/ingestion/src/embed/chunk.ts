/**
 * Re-exports from @oxagen/code-graph — the canonical home for the text chunker.
 *
 * Backward-compat shim: all existing imports from "./chunk" or
 * "@oxagen/ingestion/embed" continue to work unchanged.
 */
export { chunkText } from "@oxagen/code-graph/chunk";
export type { TextChunk, ChunkOptions, ChunkResult } from "@oxagen/code-graph/chunk";
