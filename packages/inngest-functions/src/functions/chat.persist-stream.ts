import { inngest } from "../inngest.js";
import { db, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { insertTokenUsage } from "@oxagen/telemetry";
import { logger } from "../logger.js";

/**
 * Terminal persistence for a streamed assistant turn. The streaming UI
 * accumulates tokens; once the stream resolves it fires this event with the
 * final content and usage. The runner writes the final content to
 * chat.messages and the per-turn metrics to ClickHouse token_usage.
 *
 * Why split Postgres/ClickHouse here: spec §3 mandates the boundary —
 * messages are durable transactional state, token telemetry is append-only.
 */
export const chatPersistStream = inngest.createFunction(
  { id: "chat.persist-stream", retries: 3 },
  { event: "chat/message.streamed" },
  async ({ event, step }) => {
    const { orgId, workspaceId, assistantMessageId, content, tokenUsage } = event.data;

    await step.run("update-message", async () => {
      const d = db();
      await d
        .update(schema.messages)
        .set({
          content,
          metadata: { status: "complete" },
          updatedAt: new Date(),
        })
        .where(eq(schema.messages.id, assistantMessageId));
    });

    if (tokenUsage) {
      await step.run("insert-token-usage", async () => {
        // provider, duration_ms, and prompt_hash are not available at this
        // callsite; sentinel values are used. TODO(OXA): thread provider and
        // duration through the chat/message.streamed event payload.
        await insertTokenUsage([
          {
            execution_step_id: assistantMessageId,
            org_id: orgId,
            workspace_id: workspaceId,
            model: tokenUsage.model,
            provider: "",
            input_tokens: tokenUsage.inputTokens,
            output_tokens: tokenUsage.outputTokens,
            cached_tokens: tokenUsage.cachedTokens,
            cost_usd_micros: tokenUsage.costMicros,
            duration_ms: 0,
            surface: "runner",
            prompt_hash: "",
            created_at: new Date().toISOString(),
          },
        ]);
      });
    }

    logger.info({ assistantMessageId, hasTokenUsage: tokenUsage !== null }, "chat.persist-stream complete");
    return { persisted: assistantMessageId };
  },
);
