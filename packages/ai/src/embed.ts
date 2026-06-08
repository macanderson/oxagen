import pino from "pino";
import { embed } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { insertTokenUsage, providerFromModelId, hashPrompt, type Surface } from "@oxagen/telemetry";
import { providerCostUsdMicros } from "@oxagen/billing";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info", base: { app: "ai.embed" } });

// Match the 1536-dim AgentMemory vector index. Swapping models requires a
// re-index, so we pin here and treat the index name as the contract. `MODEL` is
// the logical id used for cost/telemetry; `GATEWAY_MODEL` is the `creator/model`
// id the Vercel AI Gateway addresses.
const MODEL = "text-embedding-3-small";
const GATEWAY_MODEL = "openai/text-embedding-3-small";

export interface EmbedTextOpts {
  /**
   * Required telemetry context forwarded from the caller's CapabilityContext.
   * Every embedding call must be metered so the token_usage table is the
   * complete billing record (OXA-1351 / OXA-1425). Tests that do not exercise
   * the ClickHouse path should mock @oxagen/telemetry.insertTokenUsage rather
   * than omitting this field.
   */
  telemetry: {
    orgId: string;
    workspaceId: string;
    surface: Surface;
    /** Correlation key — usually the message/request id that initiated the turn. */
    executionStepId: string;
  };
}

/**
 * Embed `text` using the pinned embedding model through the Vercel AI Gateway
 * and write one `token_usage` row to ClickHouse via @oxagen/telemetry
 * (best-effort, never throws). Surface origin and execution step flow through
 * `opts.telemetry` so every embedding call is metered alongside language-model
 * calls (OXA-1351 / OXA-1425). The gateway client reads `AI_GATEWAY_API_KEY`
 * from the environment — there is no direct-provider fallback.
 */
export async function embedText(text: string, opts: EmbedTextOpts): Promise<number[]> {
  const model = gateway.embeddingModel(GATEWAY_MODEL);
  const startedAt = Date.now();

  const { embedding, usage } = await embed({ model, value: text });

  const { orgId, workspaceId, surface, executionStepId } = opts.telemetry;
  const durationMs = Date.now() - startedAt;
  const inputTokens = usage?.tokens ?? 0;
  // Embeddings are input-only; the rate card prices them per the same meter.
  const costUsdMicros = providerCostUsdMicros({ model: MODEL, inputTokens, outputTokens: 0 });
  try {
    const promptHash = await hashPrompt(text);
    await insertTokenUsage([
      {
        execution_step_id: executionStepId,
        org_id: orgId,
        workspace_id: workspaceId,
        model: MODEL,
        provider: providerFromModelId(`openai:${MODEL}`),
        input_tokens: inputTokens,
        output_tokens: 0,
        cached_tokens: 0,
        cost_usd_micros: costUsdMicros,
        duration_ms: durationMs,
        surface,
        prompt_hash: promptHash,
        created_at: new Date().toISOString(),
      },
    ]);
  } catch (err) {
    // Telemetry is best-effort; never fail the caller.
    logger.error({ err }, "embedText telemetry write failed");
  }

  return embedding;
}
