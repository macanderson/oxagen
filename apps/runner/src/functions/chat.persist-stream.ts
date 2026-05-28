import { inngest } from "../inngest.js";
import { db, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { clickhouse } from "@oxagen/telemetry";

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
    const { tenantId, assistantMessageId, content, tokenUsage } = event.data;

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
        const ch = clickhouse();
        await ch.insert({
          table: "token_usage",
          values: [
            {
              execution_step_id: assistantMessageId,
              tenant_id: tenantId,
              model: tokenUsage.model,
              input_tokens: tokenUsage.inputTokens,
              output_tokens: tokenUsage.outputTokens,
              cached_tokens: tokenUsage.cachedTokens,
              cost_usd_micros: tokenUsage.costMicros,
              created_at: new Date().toISOString(),
            },
          ],
          format: "JSONEachRow",
        });
      });
    }

    return { persisted: assistantMessageId };
  },
);
