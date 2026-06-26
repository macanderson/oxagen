import { createFunction } from "../create-function";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology";
import { logger } from "../logger";

/**
 * Async dual-write: mirror an Engram memory record into Neo4j as graph edges.
 *
 * Triggered by `engram/memory.graph-sync` after a record is appended to the
 * episodic store. Creates:
 *   - (:EngramMemory) node with the record's metadata
 *   - (target)-[:REMEMBERS]->(m) edge from nodeRef entity to the memory
 *   - (m)-[:ABOUT]->(kn) edges to related KnowledgeNodes
 *
 * Idempotent: MERGE on recordId means re-delivery never duplicates.
 * Retry: up to 17 times over ~24 h (Inngest default exponential backoff).
 * If Neo4j is permanently unreachable, the engram record still exists in
 * the episodic store — graph edges are eventually consistent.
 */
export const [engramSyncMemoryToGraph] = createFunction(
  {
    id: "engram.sync-memory-to-graph",
    retries: 17,
    concurrency: { limit: 8, key: "event.data.orgId" },
  },
  { event: "engram/memory.graph-sync" },
  async ({ event, step }) => {
    const {
      recordId,
      orgId,
      workspaceId,
      nodeRef,
      entityRefs,
      body,
      kind,
      salience,
    } = event.data as {
      recordId: string;
      orgId: string;
      workspaceId: string;
      nodeRef?: string | null;
      entityRefs?: string[] | null;
      body: string;
      kind: string;
      salience: number;
    };

    await step.run("write-neo4j-memory-and-edges", () =>
      runInTenantScope({ orgId, workspaceId }, async () => {
        const s = scopedSession();
        try {
          await s.run(
            /* cypher */ `
              MERGE (m:EngramMemory {recordId: $recordId, orgId: $orgId, workspaceId: $workspaceId})
              ON CREATE SET
                m.body = $body,
                m.kind = $kind,
                m.salience = $salience,
                m.createdAt = datetime()
              ON MATCH SET
                m.salience = $salience

              // :REMEMBERS — link from the entity this memory is about
              WITH m
              CALL {
                WITH m
                WITH m
                WHERE $nodeRef IS NOT NULL
                OPTIONAL MATCH (target {id: $nodeRef, orgId: $orgId})
                FOREACH (_ IN CASE WHEN target IS NOT NULL THEN [1] ELSE [] END |
                  MERGE (target)-[:REMEMBERS]->(m)
                )
              }

              // :ABOUT — link to related KnowledgeNodes
              WITH m
              CALL {
                WITH m
                UNWIND $entityRefs AS nid
                OPTIONAL MATCH (kn:KnowledgeNode {publicId: nid, orgId: $orgId})
                FOREACH (_ IN CASE WHEN kn IS NOT NULL THEN [1] ELSE [] END |
                  MERGE (m)-[:ABOUT]->(kn)
                )
              }
            `,
            {
              recordId,
              body: body.slice(0, 2000), // Truncate long bodies for graph storage
              kind,
              salience,
              nodeRef: nodeRef ?? null,
              entityRefs: entityRefs ?? [],
            },
          );
        } finally {
          await s.close();
        }
      }),
    );

    logger.info(
      { recordId, orgId, nodeRef, entityRefCount: entityRefs?.length ?? 0 },
      "engram.sync-memory-to-graph: synced",
    );
    return { recordId, synced: true };
  },
);
