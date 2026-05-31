import { embed } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { requireEnv } from "@oxagen/config/env";
import { insertTokenUsage, providerFromModelId, hashPrompt, type Surface } from "@oxagen/telemetry";

// Match the 1536-dim AgentMemory vector index. Swapping models requires a
// re-index, so we pin here and treat the index name as the contract.
const MODEL = "text-embedding-3-small";

export interface EmbedTextOpts {
  /**
   * Telemetry context forwarded from the caller's CapabilityContext.
   * When omitted the token-usage row is skipped (e.g. in tests that
   * mock at the seam rather than at the ClickHouse client).
   */
  telemetry?: {
    orgId: string;
    workspaceId: string;
    surface: Surface;
    /** Correlation key — usually the message/request id that initiated the turn. */
    executionStepId: string;
  };
}

/**
 * Embed `text` using the pinned OpenAI embedding model and write one
 * `token_usage` row to ClickHouse via @oxagen/telemetry (best-effort,
 * never throws). Surface origin and execution step flow through
 * `opts.telemetry` so every embedding call is metered alongside
 * language-model calls (OXA-1351 / OXA-1425).
 */
export async function embedText(text: string, opts: EmbedTextOpts = {}): Promise<number[]> {
  const env = requireEnv(["OPENAI_API_KEY"] as const);
  const client = env.OPENAI_API_KEY
    ? createOpenAI({ apiKey: env.OPENAI_API_KEY })
    : createOpenAI();
  const model = client.embedding(MODEL);
  const startedAt = Date.now();

  const { embedding, usage } = await embed({ model, value: text });

  if (opts.telemetry) {
    const { orgId, workspaceId, surface, executionStepId } = opts.telemetry;
    const durationMs = Date.now() - startedAt;
    try {
      const promptHash = await hashPrompt(text);
      await insertTokenUsage([
        {
          execution_step_id: executionStepId,
          org_id: orgId,
          workspace_id: workspaceId,
          model: MODEL,
          provider: providerFromModelId(`openai:${MODEL}`),
          input_tokens: usage?.tokens ?? 0,
          output_tokens: 0,
          cached_tokens: 0,
          cost_usd_micros: 0,
          duration_ms: durationMs,
          surface,
          prompt_hash: promptHash,
          created_at: new Date().toISOString(),
        },
      ]);
    } catch {
      // Telemetry is best-effort; never fail the caller.
    }
  }

  return embedding;
}
