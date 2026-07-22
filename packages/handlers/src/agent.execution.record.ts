import type { CapabilityHandler } from "@oxagen/oxagen";
import { agentExecutionRecord } from "@oxagen/oxagen/contracts/agent.execution.record";
import { schema, withTenantDb } from "@oxagen/database";
import { logger } from "./logger";

/**
 * recordExecution() handler: persist complete agent execution with steps and tool calls.
 * Writes to agent_executions, agent_execution_steps, and agent_tool_calls tables.
 * All three tables use workspace_id in their RLS policies for cross-workspace isolation.
 */
export const agentExecutionRecordHandler: CapabilityHandler<
  typeof agentExecutionRecord
> = async (input, ctx) => {
  const result = await withTenantDb(async (tx) => {
    // 1. Insert root execution record
    const [execution] = await tx
      .insert(schema.agentExecutions)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        agentId: input.agentId,
        agentVersionId: input.agentVersionId,
        originType: input.originType,
        originId: input.originId,
        status: input.status,
        inputPayload: input.inputPayload,
        outputPayload: input.outputPayload ?? null,
        failureReason: input.failureReason ?? null,
        startedAt: input.startedAt ?? null,
        completedAt: input.completedAt ?? null,
        latencyMs: input.latencyMs ?? null,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        estimatedCostUsd:
          input.estimatedCostUsd != null
            ? String(input.estimatedCostUsd)
            : null,
        createdByUserId: ctx.userId ?? null,
        updatedByUserId: ctx.userId ?? null,
      })
      .returning({
        id: schema.agentExecutions.id,
        createdAt: schema.agentExecutions.createdAt,
      });

    if (!execution) throw new Error("execution insert returned no row");
    const executionId = execution.id;

    // 2. Bulk-insert execution steps, then bulk-insert all tool calls. A serial
    // loop over steps with a nested serial loop over tool calls produces
    // 1 + N + (N*M) round trips on the hot execution path; two batch inserts
    // collapse that to at most two. Postgres preserves VALUES order in the
    // RETURNING result, so stepRows[i] aligns with input.steps[i].
    if (input.steps && input.steps.length > 0) {
      const stepRows = await tx
        .insert(schema.agentExecutionSteps)
        .values(
          input.steps.map((step) => ({
            executionId,
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
            stepNumber: step.stepNumber,
            stepType: step.stepType,
            status: step.status,
            inputPayload: step.inputPayload,
            outputPayload: step.outputPayload ?? null,
            failureReason: step.failureReason ?? null,
            latencyMs: step.latencyMs ?? null,
            inputTokens: step.inputTokens ?? null,
            outputTokens: step.outputTokens ?? null,
            createdByUserId: ctx.userId ?? null,
            updatedByUserId: ctx.userId ?? null,
          })),
        )
        .returning({ id: schema.agentExecutionSteps.id });

      if (stepRows.length !== input.steps.length) {
        throw new Error(
          "execution step bulk insert returned unexpected row count",
        );
      }

      const toolCallRows = input.steps.flatMap((step, i) =>
        (step.toolCalls ?? []).map((toolCall) => ({
          executionStepId: stepRows[i]!.id,
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          toolName: toolCall.toolName,
          toolType: toolCall.toolType,
          requestPayload: toolCall.requestPayload,
          responsePayload: toolCall.responsePayload ?? null,
          status: toolCall.status,
          latencyMs: toolCall.latencyMs ?? null,
          inputTokens: toolCall.inputTokens ?? null,
          outputTokens: toolCall.outputTokens ?? null,
        })),
      );

      if (toolCallRows.length > 0) {
        await tx.insert(schema.agentToolCalls).values(toolCallRows);
      }
    }

    logger.info(
      {
        executionId,
        agentId: input.agentId,
        originType: input.originType,
        status: input.status,
        stepsCount: input.steps?.length || 0,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: ctx.surface,
      },
      "agent.execution.record: execution persisted successfully",
    );

    return {
      executionId,
      status: input.status,
      createdAt: execution.createdAt,
    };
  });

  return result;
};
