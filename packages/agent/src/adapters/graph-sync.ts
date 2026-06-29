/**
 * In-app GraphSyncProvider — materialises touched files into the knowledge
 * graph and records execution-lineage TOUCHED_FILE edges on every agent turn.
 *
 * Both `ensureGraph` and `recordLineage` are designed to be called
 * fire-and-forget (`void Promise.resolve(...).catch(() => {})`). They MUST
 * NOT throw — any Neo4j error is swallowed silently so the agent turn is never
 * affected.
 *
 * Tenant scope is injected by the kernel's `runInTenantScope` ALS — every
 * method must be called from within a live capability invocation.
 */
import { scopedSession, recordExecutionInGraph } from "@oxagen/ontology";
import type { GraphSyncProvider } from "@oxagen/agent-engine";

/**
 * Construction args: supply the GitHub repo coordinates so naturalKeys
 * are formatted as `github:{owner}/{repo}:{path}` (matching the ingestion
 * convention used by `graph.sync.push`). When coordinates are omitted the
 * raw file path is stored as-is — still valid for the lineage edge.
 */
export interface GraphSyncAdapterArgs {
  /** GitHub owner (org or user), e.g. "oxageninc". */
  owner?: string;
  /** GitHub repo name, e.g. "oxagen-platform". */
  repo?: string;
}

/**
 * Build the SourceFile naturalKey.  Format mirrors graph.sync.push:
 *   `github:{owner}/{repo}:{path}` when coordinates are provided,
 *   otherwise the raw `path`.
 */
function toNaturalKey(path: string, owner: string | undefined, repo: string | undefined): string {
  if (owner && repo) {
    // Normalise leading slash
    const normalPath = path.startsWith("/") ? path.slice(1) : path;
    return `github:${owner}/${repo}:${normalPath}`;
  }
  return path;
}

export function createGraphSyncAdapter(args: GraphSyncAdapterArgs = {}): GraphSyncProvider {
  const { owner, repo } = args;

  return {
    /**
     * Upsert minimal `:SourceFile` nodes for every touched file.
     * Safe to call before or after `recordLineage` — idempotent via MERGE.
     */
    async ensureGraph(touchedFiles: string[]): Promise<void> {
      if (touchedFiles.length === 0) return;
      const naturalKeys = touchedFiles.map((p) => toNaturalKey(p, owner, repo));
      const sess = scopedSession();
      try {
        await sess.run(
          `UNWIND $naturalKeys AS naturalKey
           MERGE (f:SourceFile {naturalKey: naturalKey, orgId: $orgId})
           ON CREATE SET
             f.path        = naturalKey,
             f.displayName = naturalKey,
             f.is_system   = true,
             f.createdAt   = datetime()`,
          { naturalKeys },
        );
      } finally {
        await sess.close();
      }
    },

    /**
     * Record `(:Execution)-[:TOUCHED_FILE]->(:SourceFile)` edges.
     * Delegates to `recordExecutionInGraph` which handles the MERGE idempotently.
     */
    async recordLineage({
      executionId,
      touchedFiles,
    }: {
      executionId: string;
      touchedFiles: string[];
    }): Promise<void> {
      if (touchedFiles.length === 0) return;
      const naturalKeys = touchedFiles.map((p) => toNaturalKey(p, owner, repo));
      await recordExecutionInGraph({
        executionId,
        // orgId + workspaceId are injected by scopedSession inside
        // recordExecutionInGraph — supply placeholders to satisfy the type;
        // scopedSession overwrites them with the ALS values.
        orgId: "",
        workspaceId: "",
        status: "completed",
        originType: "agent_coding_turn",
        originId: executionId,
        touchedFilePaths: naturalKeys,
      });
    },
  };
}
