import { withTenantDb, schema } from "@oxagen/database";
import { and, desc, eq, isNull, lt, sql, type SQL } from "drizzle-orm";
import { INTERACTIVE_AGENT_TYPE } from "@oxagen/oxagen/interactive-agent";
import { isOxagenAssistantCall } from "@oxagen/oxagen/oxagen-assistant";
import type { CapabilityContext } from "../types";
import type {
  AgentExecutionListInput,
  AgentExecutionListOutput,
} from "@oxagen/oxagen/contracts/agent.execution.list";

export type { AgentExecutionListInput, AgentExecutionListOutput };

/**
 * The condition that leaves the in-app assistant's executions out of a read
 * of `agent_executions`, or `undefined` when the caller is the assistant.
 *
 * Each assistant turn records one execution under the workspace's managed
 * `qa-chat` agent, whose `agent_type` is `interactive_chat`. That record is
 * internal. The assistant reads its own history through `list_executions`
 * and `get_execution_trace`, so a call that carries its kernel-minted binding
 * sees every row. Every other caller sees none of those rows (ADR-235). That
 * includes the workspace's people, its API keys, MCP clients, and its own
 * agents.
 *
 * The test is NOT EXISTS, not `agent_id NOT IN (...)`. `agent_id` is null on
 * a dynamic supervisor run, and `NULL NOT IN (...)` is null, which would drop
 * every such run along with the assistant's.
 *
 * `list_executions`, `get_execution_trace`, `debug_execution`, and
 * `search_command_menu` all read through it, so the four agree on what a
 * caller may see.
 */
export function assistantExecutionsHidden(
  ctx: Pick<
    CapabilityContext,
    "oxagenAssistant" | "agentRun" | "deployedAgentInvocation"
  >,
): SQL | undefined {
  if (isOxagenAssistantCall(ctx)) return undefined;
  return sql`not exists (select 1 from ${schema.agents} where ${schema.agents.id} = ${schema.agentExecutions.agentId} and ${schema.agents.agentType} = ${INTERACTIVE_AGENT_TYPE})`;
}

/**
 * List recent top-level agent runs, newest first, with keyset pagination on
 * created_at. Only root executions (parent_execution_id IS NULL) are returned —
 * one row per run; the span tree (agent.trace.get) expands a run's children.
 *
 * Keyset (not offset) so deep pages stay cheap and stable under concurrent
 * inserts. We over-fetch by one row to compute nextCursor without a count.
 *
 * The in-app assistant's executions are left out unless the assistant itself
 * asks (`assistantExecutionsHidden`, ADR-235).
 */
export async function agentExecutionListHandler(
  input: AgentExecutionListInput,
  ctx: CapabilityContext,
): Promise<AgentExecutionListOutput> {
  const limit = input.limit;

  const rows = await withTenantDb((tx) => {
    const filters = [
      eq(schema.agentExecutions.orgId, ctx.orgId),
      eq(schema.agentExecutions.workspaceId, ctx.workspaceId),
      isNull(schema.agentExecutions.parentExecutionId),
    ];
    const hidden = assistantExecutionsHidden(ctx);
    if (hidden) filters.push(hidden);
    if (input.before) {
      filters.push(
        lt(schema.agentExecutions.createdAt, new Date(input.before)),
      );
    }
    if (input.status) {
      filters.push(eq(schema.agentExecutions.status, input.status));
    }
    return (
      tx
        .select({
          publicId: schema.agentExecutions.publicId,
          agentId: schema.agentExecutions.agentId,
          originType: schema.agentExecutions.originType,
          originId: schema.agentExecutions.originId,
          status: schema.agentExecutions.status,
          startedAt: schema.agentExecutions.startedAt,
          completedAt: schema.agentExecutions.completedAt,
          latencyMs: schema.agentExecutions.latencyMs,
          inputTokens: schema.agentExecutions.inputTokens,
          outputTokens: schema.agentExecutions.outputTokens,
          estimatedCostUsd: schema.agentExecutions.estimatedCostUsd,
          createdAt: schema.agentExecutions.createdAt,
        })
        .from(schema.agentExecutions)
        .where(and(...filters))
        .orderBy(desc(schema.agentExecutions.createdAt))
        // Over-fetch by one to detect whether another page exists.
        .limit(limit + 1)
    );
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;

  return {
    executions: page.map((r) => ({
      executionId: r.publicId,
      status:
        r.status as AgentExecutionListOutput["executions"][number]["status"],
      originType: r.originType,
      originId: r.originId,
      agentId: r.agentId,
      startedAt: r.startedAt ? r.startedAt.toISOString() : null,
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      latencyMs: r.latencyMs,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      estimatedCostUsd: r.estimatedCostUsd,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor,
  };
}
