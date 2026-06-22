import { eventClient } from "./event-client";
import { logger } from "./logger";

/**
 * Shared emitter for `agent/execution.sync` — mirror a finished agent execution
 * into the Neo4j knowledge graph as lineage.
 *
 * Both agent.execution.record and chat.message.execution persist an
 * agent_executions row; this is the single place that fans the row out to the
 * graph so the two call sites can't drift. The async worker
 * (agent.sync-execution-to-graph) consumes the event and MERGEs the execution +
 * its tool calls into Neo4j.
 *
 * - Only terminal executions are projected. A "planning"/"running" row is not
 *   yet a meaningful lineage node, and recordExecution is normally called once
 *   with the final state anyway; the worker's MERGE keeps re-delivery safe.
 * - Best-effort: the Postgres row is the source of truth. A failure to enqueue
 *   is logged, never thrown — synced_to_graph_at simply stays NULL for a sweep
 *   to retry, exactly as the worker documents.
 */

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

interface ExecutionStepLike {
  toolCalls?: Array<{ toolName: string; toolType: string }> | null;
}

export interface ExecutionSyncInput {
  executionId: string;
  orgId: string;
  workspaceId: string;
  status: string;
  originType: string;
  originId: string;
  agentId?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  latencyMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimatedCostUsd?: number | null;
  steps?: ExecutionStepLike[] | null;
}

export async function emitExecutionSyncEvent(input: ExecutionSyncInput): Promise<void> {
  if (!TERMINAL_STATUSES.has(input.status)) return;

  const toolCalls = (input.steps ?? []).flatMap((step) =>
    (step.toolCalls ?? []).map((tc) => ({ toolName: tc.toolName, toolType: tc.toolType })),
  );

  try {
    await eventClient.send({
      name: "agent/execution.sync",
      data: {
        executionId: input.executionId,
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        status: input.status,
        originType: input.originType,
        originId: input.originId,
        agentId: input.agentId ?? null,
        startedAt: input.startedAt ? input.startedAt.toISOString() : null,
        completedAt: input.completedAt ? input.completedAt.toISOString() : null,
        latencyMs: input.latencyMs ?? null,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        estimatedCostUsd: input.estimatedCostUsd != null ? String(input.estimatedCostUsd) : null,
        toolCalls,
      },
    });
  } catch (err) {
    logger.warn(
      { err, executionId: input.executionId, orgId: input.orgId },
      "agent.execution: failed to enqueue knowledge-graph lineage sync",
    );
  }
}
