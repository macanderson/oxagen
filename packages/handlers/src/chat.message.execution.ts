import type { CapabilityHandler } from "@oxagen/oxagen";
import { chatMessageExecution } from "@oxagen/oxagen/contracts/chat.message.execution";
import { agentExecutionRecord } from "@oxagen/oxagen/contracts/agent.execution.record";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { invoke } from "@oxagen/oxagen";
import { logger } from "./logger";

/**
 * chatMessageExecution handler: record execution within a chat message context.
 * Delegates to agent.execution.record with origin_type='chat', origin_id=message_id.
 * Validates that the message exists in the current workspace before recording execution.
 */
export const chatMessageExecutionHandler: CapabilityHandler<typeof chatMessageExecution> = async (
  input,
  ctx,
) => {
  return await withTenantDb(async (tx) => {
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
        { messageId: input.messageId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
        "chat.message.execution: message not found in workspace",
      );
      throw new Error("message not found in this workspace");
    }

    // 2. Delegate to agent.execution.record with chat origin
    const executionResult = await invoke(agentExecutionRecord, {
      agentId: input.agentId,
      agentVersionId: input.agentVersionId,
      originType: "chat",
      originId: input.messageId,
      status: input.status,
      inputPayload: input.inputPayload,
      outputPayload: input.outputPayload,
      failureReason: input.failureReason,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      latencyMs: input.latencyMs,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      estimatedCostUsd: input.estimatedCostUsd,
      steps: input.steps,
    });

    // 3. Update message execution metadata if provided
    if (input.updateMessageMetadata) {
      await tx
        .update(schema.messages)
        .set({
          metadata: {
            executionId: executionResult.executionId,
            status: executionResult.status,
            completedAt: executionResult.createdAt,
          },
          updatedByUserId: ctx.userId || null,
        })
        .where(eq(schema.messages.id, input.messageId));
    }

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
};
