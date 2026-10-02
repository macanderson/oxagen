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

/** `<alias>.<column>`, named by the column's database name. */
function at(alias: string, column: { name: string }): SQL {
  return sql`${sql.identifier(alias)}.${sql.identifier(column.name)}`;
}

/**
 * The condition that keeps a read of `agent_executions` to the rows its
 * caller may see.
 *
 * Each assistant turn records one execution under the workspace's managed
 * `qa-chat` agent, whose `agent_type` is `interactive_chat`. That record is
 * internal, so a caller without the assistant's kernel-minted binding sees
 * none of those rows (ADR-235). That includes the workspace's people, its API
 * keys, MCP clients, and its own agents.
 *
 * A call that carries the binding is the assistant acting for one person. It
 * sees the workspace's other executions, and of its own only those of that
 * person's turns. A turn records its execution against the assistant message
 * it wrote (`origin_id`, assistant-turn.ts), so the row is theirs when that
 * message is in a conversation they hold. A call with no person sees none of
 * the assistant's rows.
 *
 * The test is NOT EXISTS, not `agent_id NOT IN (...)`. `agent_id` is null on
 * a dynamic supervisor run, and `NULL NOT IN (...)` is null, which would drop
 * every such run along with the assistant's. The inner tables' columns go in
 * as identifiers under their own aliases, so no outer alias can rename them.
 *
 * `list_executions`, `get_execution_trace`, `debug_execution`, and
 * `search_command_menu` all read through it, so the four agree on what a
 * caller may see.
 */
export function assistantExecutionsHidden(
  ctx: Pick<
    CapabilityContext,
    "oxagenAssistant" | "agentRun" | "deployedAgentInvocation" | "userId"
  >,
): SQL {
  const notAssistant = sql`not exists (select 1 from ${schema.agents} where ${schema.agents.id} = ${schema.agentExecutions.agentId} and ${schema.agents.agentType} = ${INTERACTIVE_AGENT_TYPE})`;
  if (!isOxagenAssistantCall(ctx) || !ctx.userId) return notAssistant;
  const messages = schema.messages;
  const conversations = schema.conversations;
  const m = "own_message";
  const c = "own_conversation";
  const askedByThisPerson = sql`exists (select 1 from ${messages} as ${sql.identifier(m)} join ${conversations} as ${sql.identifier(c)} on ${at(c, conversations.id)} = ${at(m, messages.conversationId)} where ${at(m, messages.id)} = ${schema.agentExecutions.originId} and ${at(m, messages.orgId)} = ${schema.agentExecutions.orgId} and ${at(m, messages.workspaceId)} = ${schema.agentExecutions.workspaceId} and ${at(c, conversations.orgId)} = ${schema.agentExecutions.orgId} and ${at(c, conversations.workspaceId)} = ${schema.agentExecutions.workspaceId} and ${at(c, conversations.userId)} = ${ctx.userId})`;
  return sql`(${notAssistant} or ${askedByThisPerson})`;
}

/**
 * List recent top-level agent runs, newest first, with keyset pagination on
 * created_at. Only root executions (parent_execution_id IS NULL) are returned —
 * one row per run; the span tree (agent.trace.get) expands a run's children.
 *
 * Keyset (not offset) so deep pages stay cheap and stable under concurrent
 * inserts. We over-fetch by one row to compute nextCursor without a count.
 *
 * The in-app assistant's executions are left out, except the person's own
 * when the assistant asks for them (`assistantExecutionsHidden`, ADR-235).
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
    filters.push(assistantExecutionsHidden(ctx));
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
