/**
 * `CodeGraphProvider` adapter — wraps the CLI's local code-graph query layer
 * (`agent/code-graph.ts`, backed by the DuckDB store / in-memory build) so the
 * engine's `code_graph` tool answers structural questions against the local
 * repository.
 */
import type { CodeGraphProvider } from "@oxagen/agent-engine";

export function createCodeGraphProvider(
  queryFn: CodeGraphProvider["query"],
): CodeGraphProvider {
  return { query: queryFn };
}
