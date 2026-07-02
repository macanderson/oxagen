/**
 * Neo4j-backed CodeGraphProvider for the platform.
 *
 * Uses the active tenant scope (injected by the kernel's runInTenantScope) —
 * every method must be called from within a live capability invocation.
 *
 * On errors the methods return a short descriptive string instead of throwing,
 * so the agent receives a degraded-but-usable tool result rather than an
 * unhandled rejection that terminates the run.
 */
import { scopedSession } from "@oxagen/ontology";
import type { CodeGraphProvider } from "@oxagen/agent-engine";

type Neo4jRecord = { get: (key: string) => unknown };

/** Format a record row as "<fileNaturalKey>:<startLine>: <kind> <name>" */
function formatRow(r: Neo4jRecord): string {
  const name = String(r.get("name") ?? "");
  const kind = String(r.get("kind") ?? "");
  const fileNaturalKey = String(r.get("fileNaturalKey") ?? "");
  const startLine = Number(r.get("startLine") ?? 0);
  return `${fileNaturalKey}:${startLine}: ${kind} ${name}`;
}

const NOT_AVAILABLE =
  "(import graph not available for this connection — use grep to find references)";
const SEMANTIC_NOT_AVAILABLE =
  "(semantic_search is not implemented for the platform code graph — use the " +
  "`code_map` tool for conceptual queries, which is backed by the Neo4j vector index)";

export function createNeo4jCodeGraphProvider(): CodeGraphProvider {
  return {
    async query(
      operation: "search" | "file_symbols" | "dependents" | "imports" | "semantic_search",
      q: string,
      limit = 25,
    ): Promise<string> {
      if (operation === "dependents" || operation === "imports") {
        return NOT_AVAILABLE;
      }
      // The CLI's local DuckDB code graph embeds file nodes lazily via the AI
      // gateway (see apps/cli/src/agent/context/semantic-index.ts); the platform
      // has no equivalent wired into this provider — `code_map` is the platform's
      // real semantic entry point (Neo4j vector index). Answer explicitly rather
      // than silently falling through to the file_symbols query below.
      if (operation === "semantic_search") {
        return SEMANTIC_NOT_AVAILABLE;
      }

      const sess = scopedSession();
      try {
        if (operation === "search") {
          const lim = BigInt(limit);
          const [symbolResult, fileResult] = await Promise.all([
            sess.run(
              `MATCH (s:SourceSymbol {orgId: $orgId})
               WHERE toLower(s.name) CONTAINS toLower($q)
               RETURN s.name AS name, s.kind AS kind, s.fileNaturalKey AS fileNaturalKey,
                      toInteger(s.startLine) AS startLine
               ORDER BY name
               LIMIT $limit`,
              { q, limit: lim },
            ),
            sess.run(
              `MATCH (f:SourceFile {orgId: $orgId})
               WHERE toLower(f.path) CONTAINS toLower($q)
                  OR toLower(f.naturalKey) CONTAINS toLower($q)
               RETURN f.path AS name, 'file' AS kind, f.naturalKey AS fileNaturalKey,
                      0 AS startLine
               ORDER BY name
               LIMIT $limit`,
              { q, limit: lim },
            ),
          ]);

          const lines = [
            ...symbolResult.records.map(formatRow),
            ...fileResult.records.map(formatRow),
          ];

          const joined = lines.join("\n");
          return joined.length > 4000 ? joined.slice(0, 4000) + "\n…(truncated)" : joined;
        }

        // file_symbols
        const result = await sess.run(
          `MATCH (f:SourceFile {orgId: $orgId})-[:CONTAINS]->(s:SourceSymbol)
           WHERE toLower(f.path) CONTAINS toLower($q)
              OR toLower(f.naturalKey) CONTAINS toLower($q)
           RETURN s.name AS name, s.kind AS kind, s.fileNaturalKey AS fileNaturalKey,
                  toInteger(s.startLine) AS startLine
           ORDER BY startLine
           LIMIT $limit`,
          { q, limit: BigInt(limit) },
        );

        const lines = result.records.map(formatRow);
        const joined = lines.join("\n");
        return joined.length > 4000 ? joined.slice(0, 4000) + "\n…(truncated)" : joined;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `(code graph query error: ${msg.slice(0, 200)})`;
      } finally {
        await sess.close();
      }
    },
  };
}
