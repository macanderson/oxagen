import { createFunction } from "../create-function";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { insertTokenUsage, type Surface } from "@oxagen/telemetry";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "../logger";

/**
 * Terminal persistence for a streamed assistant turn. The streaming UI
 * accumulates tokens; once the stream resolves it fires this event with the
 * final content and usage. The runner writes the final content to
 * chat.messages and the per-turn metrics to ClickHouse token_usage.
 *
 * Why split Postgres/ClickHouse here: spec §3 mandates the boundary —
 * messages are durable transactional state, token telemetry is append-only.
 */
export const [chatPersistStream] = createFunction(
  { id: "chat.persist-stream", retries: 3 },
  { event: "chat/message.streamed" },
  async ({ event, step }) => {
    const { orgId, workspaceId, assistantMessageId, content, tokenUsage } =
      event.data as {
        orgId: string;
        workspaceId: string;
        assistantMessageId: string;
        content: string;
        tokenUsage?: {
          model: string;
          provider?: string;
          inputTokens: number;
          outputTokens: number;
          cachedTokens?: number;
          cacheWriteTokens?: number;
          costMicros: number;
          durationMs?: number;
          surface?: Surface;
          promptHash?: string;
        } | null;
      };

    await step.run("update-message", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx
            .update(schema.messages)
            .set({
              content,
              metadata: { status: "complete" },
              updatedAt: new Date(),
            })
            .where(eq(schema.messages.id, assistantMessageId)),
        ),
      ),
    );

    if (tokenUsage) {
      await step.run("insert-token-usage", async () => {
        // OXA-1498: populate all required fields. provider, duration_ms, and
        // prompt_hash are threaded through the event payload when the streaming
        // layer provides them; sentinel values are used as fallbacks so the row
        // is always written (missing telemetry is better than missing usage).
        await insertTokenUsage([
          {
            execution_step_id: assistantMessageId,
            org_id: orgId,
            workspace_id: workspaceId,
            model: tokenUsage.model,
            // Thread provider from event payload when available; sentinel "" otherwise.
            provider:
              (tokenUsage.provider as "" | "anthropic" | "openai") ?? "",
            input_tokens: tokenUsage.inputTokens,
            output_tokens: tokenUsage.outputTokens,
            cached_tokens: tokenUsage.cachedTokens ?? 0,
            cache_write_tokens: tokenUsage.cacheWriteTokens ?? 0,
            cost_usd_micros: tokenUsage.costMicros,
            // Thread duration_ms from event payload when available; 0 sentinel otherwise.
            duration_ms: tokenUsage.durationMs ?? 0,
            // Propagate the originating surface from the event payload so
            // ClickHouse attribution reflects where the turn actually came from
            // (app, api, mcp). Defaults to "app" when omitted by older callers.
            surface: tokenUsage.surface ?? "app",
            // Thread prompt_hash from event payload when available; "" sentinel otherwise.
            prompt_hash: tokenUsage.promptHash ?? "",
            created_at: new Date().toISOString(),
          },
        ]);
      });
    }

    logger.info(
      { assistantMessageId, hasTokenUsage: tokenUsage !== null },
      "chat.persist-stream complete",
    );
    return { persisted: assistantMessageId };
  },
);
