/**
 * Graph retrieval engine — uses Phase A's dual-write :REMEMBERS/:ABOUT edges
 * to find memories structurally related to the current working context.
 *
 * Starting from the `workingSet` entity IDs, traverses Neo4j edges to find
 * EngramMemory nodes. Then looks up full records from the episodic store.
 */
import type { EpisodicStore } from "../store/episodic";
import type { RetrievalCandidate, RetrievalEngine, RetrievalQuery } from "./types";

/** Estimate token cost from body size. */
function estimateTokens(body: unknown): number {
  const str = typeof body === "string" ? body : JSON.stringify(body ?? {});
  return Math.max(1, Math.ceil(str.length / 4));
}

/**
 * Interface for the Neo4j query function. Injected so this module doesn't
 * hard-depend on neo4j-driver or @oxagen/ontology.
 */
export interface GraphQueryFn {
  (cypher: string, params: Record<string, unknown>): Promise<
    Array<{ recordId: string; salience: number }>
  >;
}

export class GraphRetrievalEngine implements RetrievalEngine {
  readonly name = "graph";
  private store: EpisodicStore;
  private queryGraph: GraphQueryFn;

  constructor(store: EpisodicStore, queryGraph: GraphQueryFn) {
    this.store = store;
    this.queryGraph = queryGraph;
  }

  async retrieve(query: RetrievalQuery): Promise<RetrievalCandidate[]> {
    if (query.workingSet.length === 0) return [];

    // Traverse :REMEMBERS and :ABOUT edges from working set entities
    const graphResults = await this.queryGraph(
      /* cypher */ `
        MATCH (entity)-[:REMEMBERS]->(m:EngramMemory)
        WHERE entity.id IN $workingSet
          AND m.orgId = $orgId
          AND m.workspaceId = $workspaceId
        RETURN m.recordId AS recordId, m.salience AS salience
        UNION
        MATCH (m:EngramMemory)-[:ABOUT]->(kn:KnowledgeNode)
        WHERE kn.publicId IN $workingSet
          AND m.orgId = $orgId
          AND m.workspaceId = $workspaceId
        RETURN m.recordId AS recordId, m.salience AS salience
        ORDER BY salience DESC
        LIMIT $limit
      `,
      {
        workingSet: query.workingSet,
        orgId: query.namespace.org,
        workspaceId: query.namespace.workspace,
        limit: query.limit,
      },
    );

    if (graphResults.length === 0) return [];

    // Dedup record IDs (same record may appear from both REMEMBERS and ABOUT)
    const seen = new Map<string, number>();
    for (const row of graphResults) {
      const existing = seen.get(row.recordId) ?? 0;
      seen.set(row.recordId, Math.max(existing, row.salience));
    }

    // Look up full records from the episodic store
    const recordIds = [...seen.keys()];
    const records = await this.store.getByIds(recordIds);

    return records.map((record) => ({
      record,
      score: Math.min(1, seen.get(record.id) ?? 0.5),
      source: "graph" as const,
      tokenCost: estimateTokens(record.body),
    }));
  }
}
