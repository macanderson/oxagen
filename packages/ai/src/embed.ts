import { embed } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { requireEnv } from "@oxagen/config/env";
import { providerFromModelId, type Surface } from "@oxagen/telemetry";
import { recordAIUsage } from "./meter.js";

// Match the 1536-dim AgentMemory vector index. Swapping models requires a
// re-index, so we pin here and treat the index name as the contract.
const MODEL = "text-embedding-3-small";

// Construct the client and embedding model once at module load. requireEnv
// parses process.env on every call, so hoisting it avoids per-request overhead
// on high-frequency paths (semantic search, memory indexing).
const _env = requireEnv(["OPENAI_API_KEY"] as const);
const _openaiClient = _env.OPENAI_API_KEY
  ? createOpenAI({ apiKey: _env.OPENAI_API_KEY })
  : createOpenAI();
const _embeddingModel = _openaiClient.embedding(MODEL);

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
  const startedAt = Date.now();

  const { embedding, usage } = await embed({ model: _embeddingModel, value: text });

  if (opts.telemetry) {
    const { orgId, workspaceId, surface, executionStepId } = opts.telemetry;
    const durationMs = Date.now() - startedAt;
    const inputTokens = usage?.tokens ?? 0;

    // Telemetry + credit metering via shared helper (best-effort; never fails
    // the caller). Embeddings are input-only; outputTokens is 0.
    await recordAIUsage({
      executionStepId,
      orgId,
      workspaceId,
      model: MODEL,
      provider: providerFromModelId(`openai:${MODEL}`),
      inputTokens,
      outputTokens: 0,
      durationMs,
      surface,
      promptTextForHash: text,
    });
  }

  return embedding;
}
