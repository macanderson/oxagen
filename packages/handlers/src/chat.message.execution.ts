import type { CapabilityHandler } from "@oxagen/oxagen";
import { chatMessageExecution } from "@oxagen/oxagen/contracts/chat.message.execution";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { projectToolUsageBestEffort } from "./project-tool-usage";

/**
 * chatMessageExecution handler: record execution within a chat message context.
 * Delegates to agent.execution.record with origin_type='chat', origin_id=message_id.
 * Validates that the message exists in the current workspace before recording execution.
 */
export const chatMessageExecutionHandler: CapabilityHandler<
  typeof chatMessageExecution
> = async (input, ctx) => {
  const result = await withTenantDb(async (tx) => {
    // 1. Verify message exists and belongs to current workspace
    const message = await tx.query.messages.findFirst({
      where: and(
        eq(schema.messages.id, input.messageId),
        eq(schema.messages.orgId, ctx.orgId),
        eq(schema.messages.workspaceId, ctx.workspaceId),
      ),
      columns: { id: true, conversationId: true },
    });

    if (!message) {
      logger.warn(
        {
          messageId: input.messageId,
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
        },
        "chat.message.execution: message not found in workspace",
      );
      throw new Error("message not found in this workspace");
    }

    // 2. Write execution record in the same transaction (atomicity with message update)
    const [execution] = await tx
      .insert(schema.agentExecutions)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        agentId: input.agentId,
        agentVersionId: input.agentVersionId,
        originType: "chat",
        originId: input.messageId,
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

    // 3. Bulk-insert execution steps, then bulk-insert all tool calls. A serial
    // loop over steps with a nested serial loop over tool calls produces
    // 1 + N + (N*M) round trips on the hot messaging path; two batch inserts
    // collapse that to at most two. Postgres preserves VALUES order in the
    // RETURNING result, so stepRows[i] aligns with input.steps[i].
    if (input.steps && input.steps.length > 0) {
      const stepRows = await tx
        .insert(schema.agentExecutionSteps)
        .values(
          input.steps.map((step) => ({
            executionId: execution.id,
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

    // 4. Update message execution metadata in same transaction (atomic with execution writes)
    if (input.updateMessageMetadata) {
      await tx
        .update(schema.messages)
        .set({
          metadata: {
            executionId: execution.id,
            status: input.status,
            completedAt: execution.createdAt,
          },
          updatedByUserId: ctx.userId ?? null,
        })
        .where(eq(schema.messages.id, input.messageId));
    }

    const executionResult = {
      executionId: execution.id,
      status: input.status,
      createdAt: execution.createdAt,
    };

    logger.info(
      {
        messageId: input.messageId,
        executionId: executionResult.executionId,
        conversationId: message.conversationId,
        status: executionResult.status,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: ctx.surface,
      },
      "chat.message.execution: execution recorded for message",
    );

    return executionResult;
  });

  await projectToolUsageBestEffort(result.executionId, ctx);

  return result;
};
