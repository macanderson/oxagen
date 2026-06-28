/**
 * Re-exports from @oxagen/code-graph — the canonical home for the markdown parser.
 *
 * Backward-compat shim: all existing imports from "./markdown" or
 * "@oxagen/ingestion/parsers" continue to work unchanged.
 */
export { parseMarkdown } from "@oxagen/code-graph/markdown";
export type { MarkdownParse } from "@oxagen/code-graph/markdown";
