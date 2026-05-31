import {
  hashPrompt,
  insertTokenUsage,
  providerFromModelId,
  type Surface,
} from "@oxagen/telemetry";
import { chargeUsageCredits, providerCostUsdMicros } from "@oxagen/billing";

export interface RecordAIUsageParams {
  executionStepId: string;
  orgId: string;
  workspaceId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  surface: Surface;
  promptTextForHash: string;
  /** When true, also debits org credits via chargeUsageCredits (default: true). */
  chargeCredits?: boolean;
}

/**
 * Write one `token_usage` row to ClickHouse and optionally debit the org's
 * credit balance. Both writes are best-effort — failures are swallowed so
 * metering never propagates to the caller.
 *
 * Extracted from the near-identical try-catch blocks in stream.ts,
 * generate-object.ts, and embed.ts to satisfy the three-strikes rule.
 */
export async function recordAIUsage(params: RecordAIUsageParams): Promise<void> {
  const {
    executionStepId,
    orgId,
    workspaceId,
    model,
    provider,
    inputTokens,
    outputTokens,
    durationMs,
    surface,
    promptTextForHash,
    chargeCredits = true,
  } = params;

  const usage = { model, inputTokens, outputTokens };
  const costUsdMicros = providerCostUsdMicros(usage);

  try {
    const promptHash = await hashPrompt(promptTextForHash);
    await insertTokenUsage([
      {
        execution_step_id: executionStepId,
        org_id: orgId,
        workspace_id: workspaceId,
        model,
        provider,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cached_tokens: 0,
        cost_usd_micros: costUsdMicros,
        duration_ms: durationMs,
        surface,
        prompt_hash: promptHash,
        created_at: new Date().toISOString(),
      },
    ]);
  } catch {
    // Swallow — telemetry must never fail the caller.
  }

  if (chargeCredits) {
    try {
      await chargeUsageCredits({
        orgId,
        referenceId: executionStepId,
        ...usage,
      });
    } catch {
      // Swallow — credit metering must never fail the caller.
    }
  }
}
