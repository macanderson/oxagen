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
}

/**
 * Merge an AgentExecution node and its relationships into the Neo4j knowledge
 * graph. Uses MERGE to stay idempotent — re-driving the same executionId is
 * safe and updates properties in place. Tenant-scoped via scopedSession().
 */
export async function recordExecutionInGraph(input: RecordExecutionInput): Promise<void> {
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
  } = input;

  const neo4j = scopedSession();
  try {
    // Upsert the primary Execution node. orgId is injected by scopedSession().
    await neo4j.run(
      `MERGE (e:${NodeLabels.Execution} {id: $executionId, orgId: $orgId})
       ON CREATE SET
         e.workspaceId   = $workspaceId,
         e.status        = $status,
         e.originType    = $originType,
         e.startedAt     = $startedAt,
         e.createdAt     = datetime()
       ON MATCH SET
         e.status        = $status,
         e.completedAt   = $completedAt,
         e.latencyMs     = $latencyMs,
         e.inputTokens   = $inputTokens,
         e.outputTokens  = $outputTokens,
         e.estimatedCostUsd = $estimatedCostUsd,
         e.updatedAt     = datetime()`,
      {
        executionId,
        workspaceId: input.workspaceId,
        status,
        originType,
        startedAt: startedAt ?? null,
        completedAt: completedAt ?? null,
        latencyMs: latencyMs ?? null,
        inputTokens: inputTokens ?? null,
        outputTokens: outputTokens ?? null,
        estimatedCostUsd: estimatedCostUsd ?? null,
      },
    );

    // Link execution → agent when agentId is provided.
    if (agentId) {
      await neo4j.run(
        `MATCH (e:${NodeLabels.Execution} {id: $executionId, orgId: $orgId})
         MERGE (a:${NodeLabels.Agent} {id: $agentId, orgId: $orgId})
         MERGE (e)-[:${EdgeTypes.INVOKED}]->(a)`,
        { executionId, agentId },
      );
    }

    // Record origin relationship — polymorphic on originType.
    const originLabel = originLabelFor(originType);
    if (originLabel) {
      await neo4j.run(
        `MATCH (e:${NodeLabels.Execution} {id: $executionId, orgId: $orgId})
         MERGE (o:${originLabel} {id: $originId, orgId: $orgId})
         MERGE (e)-[:${EdgeTypes.ORIGINATED_FROM}]->(o)`,
        { executionId, originId },
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
         MERGE (e)-[:${EdgeTypes.CALLED_TOOL}]->(t)`,
        { executionId, toolCalls },
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
    default:
      return null;
  }
}
