// limits.ts: every limit OpenAPI import enforces.
//
// Import reads a document a stranger wrote. Each limit below turns a
// document built to exhaust memory or the stack into a refusal that names
// the limit, instead of a crash.
export { DEFINITION_BYTES_MAX } from "../model/definition-limits";

/** The deepest a parsed file, the bundle, or an expanded schema may nest. */
export const DEPTH_MAX = 256;

/** The most JSON nodes the parsed files, or the bundle, may hold. */
export const PARSED_NODES_MAX = 5_000_000;

/** The most schema nodes import may produce across every tool of one document. */
export const EXPANSION_NODES_MAX = 4_000_000;

/** Past this many schema nodes in one tool, each further $ref becomes a stub. */
export const TOOL_NODES_SOFT_MAX = 10_000;

/** A schema that refers to itself is expanded this many times, then cut. */
export const RECURSION_DEPTH = 4;
