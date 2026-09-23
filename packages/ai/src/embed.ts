import pino from "pino";
import { embed, embedMany as embedManyThroughGateway } from "ai";
import { embeddingProvider, type ModelCredential } from "./models";
import type { TurnFunding } from "./funding-source";
import {
  providerFromModelId,
  hashPrompt,
  type Surface,
} from "@oxagen/telemetry";
import {
  admitTokenUsage,
  recordTokenUsage,
  voidTokenUsage,
} from "./record-token-usage";
import { providerCostUsdMicros, CREDIT_REASONS } from "@oxagen/billing";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "ai.embed" },
});

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
   * complete billing record. Tests that do not exercise
   * metering should mock the billing admission and settlement seam.
   */
  telemetry: {
    orgId: string;
    workspaceId: string;
    surface: Surface;
    /**
     * UUID of the execution step that initiated this embedding, or `null` when
     * there is no step (e.g. fire-and-forget ingestion embeddings). It flows
     * verbatim into `token_usage.execution_step_id` (a UUID column) and
     * `credit_ledger.reference_id` (a Postgres `uuid` column) — so it MUST be a
     * valid UUID or `null`. Passing a human-readable string like
     * `embed:<nodeId>` prevents delivery and settlement. Use a separate field
     * for any such correlation key.
     */
    executionStepId: string | null;
  };
  /**
   * The organisation's own key, when it has one (ADR-053 §2). Used only when
   * it is a gateway key — OpenRouter does not serve embeddings — so the
   * platform key may still answer, and then the call is billed. Which one
   * answered is decided here, not by the caller.
   */
  credential?: ModelCredential;
}

/**
 * Write the telemetry row and debit the credits for one embedding call.
 *
 * Shared by {@link embedText} and {@link embedMany} so a batch is metered as
 * ONE call — one `token_usage` row, one charge — rather than once per item.
 * Admission precedes the provider call. Usage delivery and debit commit together.
 */
async function meterEmbeddingCall(params: {
  usageId: string;
  promptHash: string;
  inputTokens: number;
  usageKnown: boolean;
  durationMs: number;
  telemetry: EmbedTextOpts["telemetry"];
  /** Who paid the vendor; `org` reports the usage and charges nothing. */
  fundedBy: TurnFunding;
}): Promise<void> {
  const { orgId, workspaceId, surface, executionStepId } = params.telemetry;
  // Embeddings are input-only; the rate card prices them per the same meter.
  const costUsdMicros = providerCostUsdMicros({
    model: MODEL,
    inputTokens: params.inputTokens,
    outputTokens: 0,
  });

  await recordTokenUsage(
    params.usageId,
    {
      execution_step_id: executionStepId,
      org_id: orgId,
      workspace_id: workspaceId,
      model: MODEL,
      provider: providerFromModelId(`openai:${MODEL}`),
      input_tokens: params.inputTokens,
      output_tokens: 0,
      cached_tokens: 0,
      cost_usd_micros: costUsdMicros,
      duration_ms: params.durationMs,
      surface,
      prompt_hash: params.promptHash,
      created_at: new Date().toISOString(),
    },
    params.fundedBy === "platform"
      ? {
          orgId,
          reason: CREDIT_REASONS.CONSUME_EMBEDDING,
          referenceId: executionStepId ?? undefined,
          model: MODEL,
          inputTokens: params.inputTokens,
          outputTokens: 0,
          cachedTokens: 0,
        }
      : undefined,
    params.usageKnown,
  );
}

/**
 * Embed `text` using the pinned embedding model through the Vercel AI Gateway
 * and write one `token_usage` row to ClickHouse via @oxagen/telemetry
 * through a durable delivery queue. Surface origin and execution step flow through
 * `opts.telemetry` so every embedding call is metered alongside language-model
 * calls. The gateway client reads `AI_GATEWAY_API_KEY`
 * from the environment — there is no direct-provider fallback.
 *
 * Embedding several texts at once? Use {@link embedMany}: it is one round trip
 * and one metered call instead of N of each.
 */
/**
 * A provider call that threw reported no usage. Close the admission so it
 * stops counting as incomplete; the provider error is what the caller sees.
 */
async function voidEmbeddingAdmission(
  usageId: string,
  opts: EmbedTextOpts,
): Promise<void> {
  await voidTokenUsage(
    usageId,
    opts.telemetry.orgId,
    opts.telemetry.workspaceId,
    "provider_call_failed",
  ).catch((err: unknown) => {
    logger.error(
      { err, usageId, alert: "billing_usage_void_failed" },
      "Embedding admission could not be voided; it stays counted as incomplete",
    );
  });
}

export async function embedText(
  text: string,
  opts: EmbedTextOpts,
): Promise<number[]> {
  const { provider, fundedBy } = embeddingProvider(opts.credential);
  const model = provider.embeddingModel(GATEWAY_MODEL);
  const startedAt = Date.now();
  const promptHash = await hashPrompt(text);
  const usageId = await admitTokenUsage(
    opts.telemetry.orgId,
    opts.telemetry.workspaceId,
  );

  const { embedding, usage } = await embed({ model, value: text }).catch(
    async (err: unknown) => {
      await voidEmbeddingAdmission(usageId, opts);
      throw err;
    },
  );

  // Warn when the AI SDK embedding response omits usage (gateway outage, partial
  // response, or SDK version skew) so the billing gap is visible in logs rather
  // than silently recorded as zero tokens / zero cost.
  if (!usage) {
    logger.warn(
      { model: MODEL, executionStepId: opts.telemetry.executionStepId },
      "embedText: usage field absent from embed() response; admission needs reconciliation",
    );
  }

  await meterEmbeddingCall({
    usageId,
    promptHash,
    inputTokens: usage?.tokens ?? 0,
    usageKnown: usage?.tokens !== undefined,
    durationMs: Date.now() - startedAt,
    telemetry: opts.telemetry,
    fundedBy,
  });

  return embedding;
}

/**
 * Embed several texts in ONE gateway call, metered ONE time.
 *
 * The per-item alternative is `texts.map(embedText)`, and it is wrong twice
 * over: N HTTP round trips, and N charges. The second used to be the expensive
 * half — every call was rounded up to a whole credit, so a batch of small texts
 * cost one credit each however little they were worth (#1413). The meter now
 * carries the sub-credit remainder, so per-item charging is at least exact; this
 * is the round trips, and it keeps one batch as one line in the usage ledger.
 *
 * Returns one vector per input, in order. An empty input does no work and is
 * not metered.
 */
export async function embedMany(
  texts: string[],
  opts: EmbedTextOpts,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const { provider, fundedBy } = embeddingProvider(opts.credential);
  const model = provider.embeddingModel(GATEWAY_MODEL);
  const startedAt = Date.now();
  const promptHash = await hashPrompt(texts.join("\n"));
  const usageId = await admitTokenUsage(
    opts.telemetry.orgId,
    opts.telemetry.workspaceId,
  );

  const { embeddings, usage } = await embedManyThroughGateway({
    model,
    values: texts,
  }).catch(async (err: unknown) => {
    await voidEmbeddingAdmission(usageId, opts);
    throw err;
  });

  if (!usage) {
    logger.warn(
      {
        model: MODEL,
        count: texts.length,
        executionStepId: opts.telemetry.executionStepId,
      },
      "embedMany: usage field absent from embedMany() response; admission needs reconciliation",
    );
  }

  await meterEmbeddingCall({
    usageId,
    promptHash,
    inputTokens: usage?.tokens ?? 0,
    usageKnown: usage?.tokens !== undefined,
    durationMs: Date.now() - startedAt,
    telemetry: opts.telemetry,
    fundedBy,
  });

  return embeddings;
}
