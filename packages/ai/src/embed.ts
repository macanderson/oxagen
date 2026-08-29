import pino from "pino";
import { embed } from "ai";
import { gateway } from "@ai-sdk/gateway";
import {
  insertTokenUsage,
  providerFromModelId,
  hashPrompt,
  type Surface,
} from "@oxagen/telemetry";
import { chargeUsageCredits, providerCostUsdMicros } from "@oxagen/billing";
import { getScope, runInTenantScope, type TenantScope } from "@oxagen/tenancy";

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
   * the ClickHouse path should mock @oxagen/telemetry.insertTokenUsage rather
   * than omitting this field.
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
     * `embed:<nodeId>` breaks BOTH writes (ClickHouse row dropped, credit charge
     * thrown-and-swallowed → unbilled). Use a separate field for any such
     * correlation key.
     */
    executionStepId: string | null;
  };
}

/**
 * Embed `text` using the pinned embedding model through the Vercel AI Gateway
 * and write one `token_usage` row to ClickHouse via @oxagen/telemetry
 * (best-effort, never throws). Surface origin and execution step flow through
 * `opts.telemetry` so every embedding call is metered alongside language-model
 * calls. The gateway client reads `AI_GATEWAY_API_KEY`
 * from the environment — there is no direct-provider fallback.
 */
export async function embedText(
  text: string,
  opts: EmbedTextOpts,
): Promise<number[]> {
  const model = gateway.embeddingModel(GATEWAY_MODEL);
  const startedAt = Date.now();

  const { embedding, usage } = await embed({ model, value: text });

  const { orgId, workspaceId, surface, executionStepId } = opts.telemetry;
  const durationMs = Date.now() - startedAt;
  // Warn when the AI SDK embedding response omits usage (gateway outage, partial
  // response, or SDK version skew) so the billing gap is visible in logs rather
  // than silently recorded as zero tokens / zero cost.
  if (!usage) {
    logger.warn(
      { model: MODEL, executionStepId },
      "embedText: usage field absent from embed() response — token count and charge will be zero",
    );
  }
  const inputTokens = usage?.tokens ?? 0;
  // Embeddings are input-only; the rate card prices them per the same meter.
  const costUsdMicros = providerCostUsdMicros({
    model: MODEL,
    inputTokens,
    outputTokens: 0,
  });
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

  // Debit the org's credits for what this embedding call cost. Best-effort and
  // post-call — a metering failure must not fail the caller (mirrors stream.ts
  // and generate-object.ts).
  //
  // chargeUsageCredits → consumeCredits → withTenantDb → requireScope, which
  // needs an active tenant scope. Request-path callers have one; Inngest workers
  // (and fire-and-forget ingestion embeddings) keep tenant scope tight around
  // their own DB ops and do NOT wrap the embed step, so this charge would
  // otherwise run scopeless and throw TenantScopeError (silently swallowed →
  // unbilled embeddings, a revenue leak). Prefer the active ALS scope, else
  // rebuild it from the trusted telemetry org/workspace. Mirrors stream.ts.
  const capturedScope: TenantScope = getScope() ?? { orgId, workspaceId };
  try {
    await runInTenantScope(capturedScope, async () => {
      await chargeUsageCredits({
        orgId,
        // referenceId is the credit_ledger.reference_id Postgres `uuid` column;
        // pass undefined (→ NULL) when there is no execution step rather than a
        // non-UUID string, which would throw and silently leave the call unbilled.
        referenceId: executionStepId ?? undefined,
        model: MODEL,
        inputTokens,
        outputTokens: 0,
        cachedTokens: 0,
      });
    });
  } catch (err) {
    // Swallow — credit metering must never fail a capability call.
    logger.error({ err }, "embedText credit charge failed");
  }

  return embedding;
}
