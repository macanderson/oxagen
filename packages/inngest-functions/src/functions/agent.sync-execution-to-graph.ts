import { createFunction } from "../create-function";
import { withTenantDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { recordExecutionInGraph } from "@oxagen/ontology";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "../logger";

/**
 * Async mirror of a completed agent execution into the Neo4j knowledge graph.
 *
 * Triggered by `agent/execution.sync` after recordExecution() commits the
 * Postgres row. Idempotent — MERGE semantics mean re-runs never duplicate
 * nodes. On success, stamps `synced_to_graph_at` so the Postgres row carries
 * the audit flag.
 *
 * Retry strategy: Inngest retries up to 17 times over ~24 h (default
 * exponential backoff). After exhaustion the function fails permanently and
 * the `synced_to_graph_at` stays NULL — a nightly cron can sweep for those.
 */
export const [agentSyncExecutionToGraph] = createFunction(
  {
    id: "agent.sync-execution-to-graph",
    retries: 17,
    // Limit concurrency per org so a burst doesn't saturate the AuraDB connection pool.
    concurrency: { limit: 4, key: "event.data.orgId" },
  },
  { event: "agent/execution.sync" },
  async ({ event, step }) => {
    const {
      executionId,
      orgId,
      workspaceId,
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
      summary,
      displayName,
      embedding,
    } = event.data as {
      executionId: string;
      orgId: string;
      workspaceId: string;
      status: string;
      originType: string;
      originId: string;
      agentId?: string;
      startedAt?: string;
      completedAt?: string;
      latencyMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      estimatedCostUsd?: string;
      toolCalls?: Array<{ toolName: string; toolType: string }>;
      summary?: string;
      displayName?: string;
      embedding?: number[] | null;
    };

    await step.run("write-neo4j", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        recordExecutionInGraph({
          executionId,
          orgId,
          workspaceId,
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
          summary,
          displayName,
          embedding,
        }),
      ),
    );

    // Mark the Postgres row as synced. Uses parameterized SQL so this function
    // does not depend on the Drizzle schema export of agent_executions — the
    // schema lives in the #4/#5 PR and this function is intentionally
    // schema-agnostic to avoid a hard import-time dependency between PRs.
    await step.run("stamp-synced-at", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx.execute(
            sql`UPDATE agent.agent_executions
                SET synced_to_graph_at = NOW()
                WHERE id = ${executionId}::uuid
                  AND org_id = ${orgId}::uuid`,
          ),
        ),
      ),
    );

    logger.info({ executionId, orgId }, "agent.sync-execution-to-graph: synced");
    return { executionId, synced: true };
  },
);
