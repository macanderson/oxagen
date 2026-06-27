import { embedText } from "@oxagen/ai";
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
 * - Embedding: computed here so the Inngest worker does not need to depend on
 *   @oxagen/ai. A failed embed is treated as best-effort — the event is still
 *   emitted with embedding: null and the node remains searchable by structural
 *   traversal; a nightly sweep can backfill missing vectors.
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

/** Build a concise human-readable summary of what happened in an execution. */
function buildSummary(input: ExecutionSyncInput, toolCalls: Array<{ toolName: string }>): string {
  const toolPart =
    toolCalls.length > 0
      ? `${toolCalls.length} tool call${toolCalls.length === 1 ? "" : "s"} (${toolCalls.map((tc) => tc.toolName).join(", ")})`
      : "no tool calls";
  const tokenPart =
    input.outputTokens != null ? `${input.outputTokens} output tokens` : "no token data";
  const agentPart = input.agentId ? ` by agent ${input.agentId}` : "";
  return `${input.originType} execution${agentPart}: ${input.status}, ${toolPart}, ${tokenPart}`;
}

/** Build a short display name for the graph node — never a raw UUID. */
function buildDisplayName(input: ExecutionSyncInput): string {
  const agentPart = input.agentId ? ` by ${input.agentId}` : "";
  return `${input.originType} execution${agentPart}`;
}

export async function emitExecutionSyncEvent(input: ExecutionSyncInput): Promise<void> {
  if (!TERMINAL_STATUSES.has(input.status)) return;

  const toolCalls = (input.steps ?? []).flatMap((step) =>
    (step.toolCalls ?? []).map((tc) => ({ toolName: tc.toolName, toolType: tc.toolType })),
  );

  const summary = buildSummary(input, toolCalls);
  const displayName = buildDisplayName(input);

  // Compute an embedding of the summary for vector search. Best-effort — a
  // failed embed never prevents the event from being emitted or the lineage
  // node from being written; the node just won't be hit by semantic search
  // until a backfill pass sets its vector.
  //
  // executionStepId MUST be null (not a synthesized string) because it flows
  // into ClickHouse `token_usage.execution_step_id` (UUID column) and
  // `credit_ledger.reference_id` (Postgres uuid column) — see EmbedTextOpts
  // docs in @oxagen/ai.
  let embedding: number[] | null = null;
  try {
    embedding = await embedText(summary, {
      telemetry: {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        surface: "runner",
        executionStepId: null,
      },
    });
  } catch (err) {
    logger.warn(
      { err, executionId: input.executionId, orgId: input.orgId },
      "agent.execution: embedding failed — lineage node will be written without a vector",
    );
  }

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
        summary,
        displayName,
        embedding,
      },
    });
  } catch (err) {
    logger.warn(
      { err, executionId: input.executionId, orgId: input.orgId },
      "agent.execution: failed to enqueue knowledge-graph lineage sync",
    );
  }
}
