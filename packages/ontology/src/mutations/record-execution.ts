import { scopedSession } from "../tenant";
import { NodeLabels, EdgeTypes } from "../types";

export interface RecordExecutionInput {
  executionId: string;
  orgId: string;
  workspaceId: string;
  status: string;
  originType: string;
  originId: string;
  agentId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  latencyMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimatedCostUsd?: string | null;
  toolCalls?: Array<{ toolName: string; toolType: string }>;
  /** Pre-computed embedding vector (1536 dims, cosine). Caller MUST compute this
   *  because @oxagen/ontology must NOT depend on @oxagen/ai. */
  embedding?: number[] | null;
  /** Human-readable summary of what the execution did. Stored on the node for
   *  full-text context and used as the source text for the embedding. */
  summary?: string | null;
  /** Short human label (e.g. "chat execution by <agentId>"). Shown in the graph
   *  explorer as the node's primary identifier instead of a raw UUID. */
  displayName?: string | null;
  /**
   * File paths (or naturalKeys) touched during this execution. Each entry is
   * MERGEd as a `:SourceFile` node and linked via a `[:TOUCHED_FILE]` edge so
   * callers can query "which files did execution X touch?" in Neo4j.
   *
   * The MERGE uses `naturalKey` as the primary key so it is idempotent — a
   * repeat call for the same file sets properties on the existing node
   * without ever overwriting the lineage edge.
   */
  touchedFilePaths?: string[] | null;
  /**
   * Extra caller-supplied entries merged into the node's properties bag (the
   * PropertyList popover payload). Fanout projection uses this for
   * fanoutId / runId / capabilityName / attempts (spec Phase 2 §2). Null and
   * undefined values are dropped like the built-in fields.
   */
  properties?: Record<string, unknown> | null;
}

/**
 * Merge an AgentExecution node and its relationships into the Neo4j knowledge
 * graph. Uses MERGE to stay idempotent — re-driving the same executionId is
 * safe and updates properties in place. Tenant-scoped via scopedSession().
 *
 * The node now carries the universal `:GraphNode` anchor label so it appears in
 * the graph explorer and is hit by the `graph_node_embedding_index` vector search.
 */
export async function recordExecutionInGraph(
  input: RecordExecutionInput,
): Promise<void> {
  const {
    executionId,
    status,
    originType,
    originId,
    agentId,
    startedAt,
    completedAt,
    latencyMs,
    inputTokens,
    outputTokens,
    estimatedCostUsd,
    toolCalls,
    embedding,
    summary,
    displayName,
    touchedFilePaths,
  } = input;

  // Build a compact JSON properties bag for the node — this is what the graph
  // explorer surfaces in the PropertyList popover. Null/undefined values are
  // omitted so the bag stays lean.
  const toolNames = toolCalls?.map((tc) => tc.toolName) ?? [];
  const extraProperties = Object.fromEntries(
    Object.entries(input.properties ?? {}).filter(
      ([, v]) => v !== null && v !== undefined,
    ),
  );
  const propertiesBag: Record<string, unknown> = {
    status,
    originType,
    ...(agentId != null && { agentId }),
    ...(latencyMs != null && { latencyMs }),
    ...(inputTokens != null && { inputTokens }),
    ...(outputTokens != null && { outputTokens }),
    ...(estimatedCostUsd != null && { estimatedCostUsd }),
    ...(toolNames.length > 0 && { toolNames }),
    ...extraProperties,
  };
  const properties = JSON.stringify(propertiesBag);

  const neo4j = scopedSession();
  try {
    // Upsert the primary Execution node.
    // ON CREATE sets immutable identity fields (publicId, label, workspaceId, startedAt).
    // ON MATCH updates mutable state (status, tokens, latency, displayName, properties).
    // The embedding FOREACH guard conditionally sets the vector and its timestamp only
    // when a non-null embedding is supplied — a null embedding must never overwrite an
    // existing vector from a prior call.
    await neo4j.run(
      `MERGE (e:${NodeLabels.Execution} {id: $executionId, orgId: $orgId})
       ON CREATE SET
         e:GraphNode,
         e.is_system      = true,
         e.publicId       = $executionId,
         e.label          = 'Execution',
         e.workspaceId    = $workspaceId,
         e.status         = $status,
         e.originType     = $originType,
         e.displayName    = $displayName,
         e.properties     = $properties,
         e.summary        = $summary,
         e.startedAt      = $startedAt,
         e.createdAt      = datetime()
       ON MATCH SET
         e:GraphNode,
         e.is_system      = true,
         e.label          = 'Execution',
         e.status         = $status,
         e.completedAt    = $completedAt,
         e.latencyMs      = $latencyMs,
         e.inputTokens    = $inputTokens,
         e.outputTokens   = $outputTokens,
         e.estimatedCostUsd = $estimatedCostUsd,
         e.displayName    = $displayName,
         e.properties     = $properties,
         e.summary        = $summary,
         e.updatedAt      = datetime()
       FOREACH (_ IN CASE WHEN $embedding IS NULL THEN [] ELSE [1] END |
         SET e.embedding          = $embedding,
             e.embeddingUpdatedAt = datetime()
       )`,
      {
        executionId,
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        status,
        originType,
        startedAt: startedAt ?? null,
        completedAt: completedAt ?? null,
        latencyMs: latencyMs ?? null,
        inputTokens: inputTokens ?? null,
        outputTokens: outputTokens ?? null,
        estimatedCostUsd: estimatedCostUsd ?? null,
        displayName: displayName ?? `${originType} execution`,
        properties,
        summary: summary ?? null,
        embedding: embedding ?? null,
      },
    );

    // Link execution → agent when agentId is provided. The INVOKED relationship
    // is product-owned so it carries is_system = true.
    if (agentId) {
      await neo4j.run(
        `MATCH (e:${NodeLabels.Execution} {id: $executionId, orgId: $orgId})
         MERGE (a:${NodeLabels.Agent} {id: $agentId, orgId: $orgId})
         MERGE (e)-[r:${EdgeTypes.INVOKED}]->(a)
         SET r.is_system = true`,
        { executionId, orgId: input.orgId, agentId },
      );
    }

    // Record origin relationship — polymorphic on originType. Product-owned.
    const originLabel = originLabelFor(originType);
    if (originLabel) {
      await neo4j.run(
        `MATCH (e:${NodeLabels.Execution} {id: $executionId, orgId: $orgId})
         MERGE (o:${originLabel} {id: $originId, orgId: $orgId})
         MERGE (e)-[r:${EdgeTypes.ORIGINATED_FROM}]->(o)
         SET r.is_system = true`,
        { executionId, orgId: input.orgId, originId },
      );
    }

    // Record per-tool-call edges in a single round-trip via UNWIND. One
    // session.run() per tool call is an N+1 against Neo4j on the execution hot
    // path; UNWIND collapses all tool-call MERGEs into one query.
    if (toolCalls?.length) {
      await neo4j.run(
        `MATCH (e:${NodeLabels.Execution} {id: $executionId, orgId: $orgId})
         UNWIND $toolCalls AS tc
         MERGE (t:${NodeLabels.Tool} {name: tc.toolName, type: tc.toolType, orgId: $orgId})
         MERGE (e)-[r:${EdgeTypes.CALLED_TOOL}]->(t)
         SET r.is_system = true`,
        { executionId, orgId: input.orgId, toolCalls },
      );
    }

    // Record file-level lineage: MERGE a minimal :SourceFile for each path and
    // link it from the Execution with a [:TOUCHED_FILE] edge. Uses naturalKey
    // as the primary key so the MERGE is idempotent across repeat calls —
    // it will never clobber the edge. Single round-trip via UNWIND.
    if (touchedFilePaths?.length) {
      await neo4j.run(
        `MATCH (e:${NodeLabels.Execution} {id: $executionId, orgId: $orgId})
         UNWIND $touchedFilePaths AS naturalKey
         MERGE (f:SourceFile {naturalKey: naturalKey, orgId: $orgId})
         ON CREATE SET
           f.path         = naturalKey,
           f.displayName  = naturalKey,
           f.is_system    = true,
           f.createdAt    = datetime()
         MERGE (e)-[r:${EdgeTypes.TOUCHED_FILE}]->(f)
         SET r.is_system = true`,
        { executionId, orgId: input.orgId, touchedFilePaths },
      );
    }
  } finally {
    await neo4j.close();
  }
}

function originLabelFor(originType: string): string | null {
  switch (originType) {
    case "chat":
      return NodeLabels.Conversation;
    case "workflow_run":
      return NodeLabels.WorkflowRun;
    case "fanout":
      return NodeLabels.Fanout;
    default:
      return null;
  }
}
