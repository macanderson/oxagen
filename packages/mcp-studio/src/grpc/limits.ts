// limits.ts: every limit gRPC import enforces.
//
// Import reads protos a stranger wrote. Each limit below turns a definition
// built to exhaust memory or the stack into a refusal or a stub that names
// the limit, instead of a crash. The numbers match OpenAPI import's.
export { DEFINITION_BYTES_MAX } from "../model/definition-limits";

/** Past this depth, a message's schema becomes a stub. */
export const DEPTH_MAX = 256;

/** The most schema nodes import may produce across every tool of one definition. */
export const EXPANSION_NODES_MAX = 4_000_000;

/** Past this many schema nodes in one tool, each further message becomes a stub. */
export const TOOL_NODES_SOFT_MAX = 10_000;

/** A message that refers to itself is expanded this many times, then cut. */
export const RECURSION_DEPTH = 4;

/** A count as a person reads it: 4,000,000. */
export function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** An error's message, for a refusal that quotes a library's error. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
