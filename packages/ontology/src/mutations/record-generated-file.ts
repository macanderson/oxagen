import { scopedSession } from "../tenant";
import { NodeLabels, EdgeTypes } from "../types";

export interface RecordGeneratedFileInput {
  /** User-facing asset id ("gen_…") — the node's publicId. */
  publicId: string;
  orgId: string;
  workspaceId: string;
  /** Asset kind (image/video/document/spreadsheet/presentation/pdf/archive). */
  kind: string;
  mimeType: string;
  model: string;
  /** Short, human-readable label — never a raw UUID. */
  displayName: string;
  /** The generation prompt (provenance). */
  prompt?: string | null;
  /** The conversation the file belongs to (for context, optional). */
  conversationId?: string | null;
  /** The chat message that produced the file — used to link the execution. */
  messageId?: string | null;
  /** The embedding source text (title + extracted content), stored as
   *  `properties.content` so graph.search can build a snippet. */
  summary?: string | null;
  /** Pre-computed embedding vector (1536 dims, cosine). Caller MUST compute this
   *  because @oxagen/ontology must NOT depend on @oxagen/ai. */
  embedding?: number[] | null;
}

/**
 * Merge a GeneratedFile node (and its lineage to the producing agent execution)
 * into the Neo4j knowledge graph. Idempotent via MERGE — re-driving the same
 * publicId is safe and updates properties in place. Tenant-scoped via
 * scopedSession().
 *
 * The node carries the universal `:GraphNode` anchor label + an `embedding`, so
 * it is returned by the shared `graph_node_embedding_index` vector search — a
 * user asking "find the files I created about nautilus" hits these nodes with no
 * search-side schema change.
 *
 * Lineage: the agent execution rows are written with `originId = messageId` for
 * chat-originated executions. We therefore link every execution that originated
 * from the file's `messageId` to the file via (:Execution)-[:PRODUCED]->(:GeneratedFile).
 * If the execution hasn't synced to the graph yet (race), the file node is still
 * written and searchable; a later re-sync/sweep attaches the edge (MERGE-safe).
 */
export async function recordGeneratedFileInGraph(input: RecordGeneratedFileInput): Promise<void> {
  const {
    publicId,
    orgId,
    workspaceId,
    kind,
    mimeType,
    model,
    displayName,
    prompt,
    conversationId,
    messageId,
    summary,
    embedding,
  } = input;

  // Compact JSON properties bag surfaced in the graph explorer. `content` is the
  // embed source text so graph.search's buildSnippet shows a useful excerpt.
  const propertiesBag: Record<string, unknown> = {
    kind,
    mimeType,
    model,
    ...(prompt != null && prompt.length > 0 && { prompt }),
    ...(conversationId != null && { conversationId }),
    ...(messageId != null && { messageId }),
    ...(summary != null && summary.length > 0 && { content: summary }),
  };
  const properties = JSON.stringify(propertiesBag);

  const neo4j = scopedSession();
  try {
    await neo4j.run(
      `MERGE (f:${NodeLabels.GeneratedFile} {publicId: $publicId, orgId: $orgId})
       ON CREATE SET
         f:GraphNode,
         f.is_system   = true,
         f.label       = 'GeneratedFile',
         f.workspaceId = $workspaceId,
         f.kind        = $kind,
         f.mimeType    = $mimeType,
         f.displayName = $displayName,
         f.properties  = $properties,
         f.summary     = $summary,
         f.createdAt   = datetime()
       ON MATCH SET
         f:GraphNode,
         f.is_system   = true,
         f.label       = 'GeneratedFile',
         f.kind        = $kind,
         f.mimeType    = $mimeType,
         f.displayName = $displayName,
         f.properties  = $properties,
         f.summary     = $summary,
         f.updatedAt   = datetime()
       FOREACH (_ IN CASE WHEN $embedding IS NULL THEN [] ELSE [1] END |
         SET f.embedding          = $embedding,
             f.embeddingUpdatedAt = datetime()
       )`,
      {
        publicId,
        orgId,
        workspaceId,
        kind,
        mimeType,
        displayName,
        properties,
        summary: summary ?? null,
        embedding: embedding ?? null,
      },
    );

    // Lineage: link the producing agent execution(s) → this file. Chat-originated
    // executions carry originId = messageId. Product-owned edge (is_system).
    if (messageId) {
      await neo4j.run(
        `MATCH (f:${NodeLabels.GeneratedFile} {publicId: $publicId, orgId: $orgId})
         MATCH (e:${NodeLabels.Execution} {orgId: $orgId})
         WHERE e.originType = 'chat' AND e.originId = $messageId
         MERGE (e)-[r:${EdgeTypes.PRODUCED}]->(f)
         SET r.is_system = true`,
        { publicId, orgId, messageId },
      );
    }
  } finally {
    await neo4j.close();
  }
}
