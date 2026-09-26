import pino from "pino";
import { embed, embedMany as embedManyThroughProvider } from "ai";
import { APICallError, type EmbeddingModelV4 } from "@ai-sdk/provider";
import { requireEnv } from "@oxagen/config/env";
import { createVoyageEmbeddingModel, type VoyageInputType } from "./voyage";
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

// Every Neo4j vector index is sized to this model's vectors
// (packages/ontology/src/schema.cypher). Changing either constant means
// resizing the indexes and embedding every stored text again, so both are
// pinned here. Mac chose Voyage with one platform key for every organisation
// on 2026-09-26 (#4148, ADR-194).
export const EMBEDDING_MODEL = "voyage-4-large";
export const EMBEDDING_DIMENSIONS = 1024;
const MODEL = EMBEDDING_MODEL;

/**
 * Embeddings could not be produced: the key is missing, Voyage refused the
 * key or the request, or Voyage stayed unavailable after the SDK's retries.
 *
 * Carries a stable `code` so the API answers 503 with the provider's reason
 * instead of an unhandled 500 (#4148). `statusCode` and `providerMessage` are
 * what Voyage said, when it said anything.
 */
export class EmbeddingUnavailableError extends Error {
  readonly code = "embedding_unavailable" as const;
  readonly provider = "voyage" as const;
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly providerMessage?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "EmbeddingUnavailableError";
  }
}

/**
 * Wrap a provider failure. The AI SDK wraps the last attempt in a RetryError
 * after its retries, so the APICallError is read from `lastError` when present.
 */
function embeddingUnavailable(err: unknown): EmbeddingUnavailableError {
  if (err instanceof EmbeddingUnavailableError) return err;
  const last =
    typeof err === "object" && err !== null && "lastError" in err
      ? (err as { lastError: unknown }).lastError
      : err;
  const apiError = APICallError.isInstance(last) ? last : undefined;
  const providerMessage = apiError?.responseBody?.slice(0, 500);
  return new EmbeddingUnavailableError(
    apiError?.statusCode
      ? `Embeddings are unavailable: Voyage answered ${apiError.statusCode}`
      : "Embeddings are unavailable: Voyage could not be reached",
    apiError?.statusCode,
    providerMessage ?? (err instanceof Error ? err.message : String(err)),
    { cause: err },
  );
}

/** The platform's Voyage model, built per call so a rotated key takes effect. */
function voyageModel(inputType: VoyageInputType | undefined): EmbeddingModelV4 {
  // An empty value fails the schema's min(1) inside requireEnv, and an unset
  // one passes it as undefined. Both are the same fault to the caller: a 503
  // naming the key, never a 500 from a config parse.
  let apiKey: string | undefined;
  let invalid: unknown;
  try {
    apiKey = requireEnv(["VOYAGE_API_KEY"] as const).VOYAGE_API_KEY;
  } catch (err) {
    invalid = err;
  }
  if (!apiKey) {
    throw new EmbeddingUnavailableError(
      "Embeddings are unavailable: VOYAGE_API_KEY is not set",
      undefined,
      undefined,
      invalid === undefined ? undefined : { cause: invalid },
    );
  }
  return createVoyageEmbeddingModel({
    apiKey,
    modelId: EMBEDDING_MODEL,
    outputDimension: EMBEDDING_DIMENSIONS,
    inputType,
  });
}

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
   * `document` for text Oxagen stores and later searches, `query` for text it
   * searches with. Voyage embeds the two differently, and recall is better
   * when each side says which it is. Leave unset for symmetric comparisons,
   * such as one prompt against another.
   */
  inputType?: VoyageInputType;
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
      provider: providerFromModelId(`voyage:${MODEL}`),
      input_tokens: params.inputTokens,
      output_tokens: 0,
      cached_tokens: 0,
      cost_usd_micros: costUsdMicros,
      duration_ms: params.durationMs,
      surface,
      prompt_hash: params.promptHash,
      created_at: new Date().toISOString(),
    },
    // Oxagen's key serves every embedding, so every embedding is charged.
    {
      orgId,
      reason: CREDIT_REASONS.CONSUME_EMBEDDING,
      referenceId: executionStepId ?? undefined,
      model: MODEL,
      inputTokens: params.inputTokens,
      outputTokens: 0,
      cachedTokens: 0,
    },
    params.usageKnown,
  );
}

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

/**
 * Embed `text` with the pinned Voyage model on the platform key and write one
 * `token_usage` row to ClickHouse via @oxagen/telemetry through a durable
 * delivery queue. Surface origin and execution step flow through
 * `opts.telemetry` so every embedding call is metered alongside language-model
 * calls. The key is `VOYAGE_API_KEY`. There is no fallback provider: a failure
 * throws {@link EmbeddingUnavailableError}.
 *
 * Embedding several texts at once? Use {@link embedMany}: it is one round trip
 * and one metered call instead of N of each.
 */
export async function embedText(
  text: string,
  opts: EmbedTextOpts,
): Promise<number[]> {
  const model = voyageModel(opts.inputType);
  const startedAt = Date.now();
  const promptHash = await hashPrompt(text);
  const usageId = await admitTokenUsage(
    opts.telemetry.orgId,
    opts.telemetry.workspaceId,
  );

  const { embedding, usage } = await embed({ model, value: text }).catch(
    async (err: unknown) => {
      await voidEmbeddingAdmission(usageId, opts);
      throw embeddingUnavailable(err);
    },
  );

  // Warn when the embedding response omits usage (a partial response or SDK
  // version skew) so the billing gap is visible in logs rather than silently
  // recorded as zero tokens and zero cost.
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
  });

  return embedding;
}

/**
 * Embed several texts in ONE provider call, metered ONE time.
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

  const model = voyageModel(opts.inputType);
  const startedAt = Date.now();
  const promptHash = await hashPrompt(texts.join("\n"));
  const usageId = await admitTokenUsage(
    opts.telemetry.orgId,
    opts.telemetry.workspaceId,
  );

  const { embeddings, usage } = await embedManyThroughProvider({
    model,
    values: texts,
  }).catch(async (err: unknown) => {
    await voidEmbeddingAdmission(usageId, opts);
    throw embeddingUnavailable(err);
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
  });

  return embeddings;
}
