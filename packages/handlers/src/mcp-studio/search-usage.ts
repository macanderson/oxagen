// search-usage.ts: record the tokens the oxagen provider's search embeddings
// use (lane M15; ADR-217).
//
// Search entries embed outside @oxagen/ai (ADR-217, decision 1). This writes
// the token_usage row @oxagen/ai writes for its own embeddings: the tokens,
// the duration, the surface, the prompt hash, and the provider's cost. It
// charges no credits, because the oxagen provider's spend is platform cost.
// A custom provider bills the workspace's own account, so nothing records
// it here. A failure is logged by its name and never fails a search or a
// publish.
import { admitUsage, finalizeUsage, providerCostUsdMicros } from "@oxagen/billing";
import type { EmbedUsage } from "@oxagen/mcp-studio";
import { hashPrompt, providerFromModelId, stampTokenUsage } from "@oxagen/telemetry";
import { runInTenantScope, type TenantScope } from "@oxagen/tenancy";
import { logger } from "../logger";

const notRecorded = "The token count of a search embedding was not recorded. Search and publish go on.";

async function record(scope: TenantScope, model: string, usage: EmbedUsage): Promise<void> {
  const inputTokens = usage.tokens ?? 0;
  const promptHash = await hashPrompt(usage.texts.join("\n"));
  await runInTenantScope(scope, async () => {
    const [row] = stampTokenUsage([
      {
        execution_step_id: null,
        org_id: scope.orgId,
        workspace_id: scope.workspaceId,
        model,
        provider: providerFromModelId(`voyage:${model}`),
        input_tokens: inputTokens,
        output_tokens: 0,
        cached_tokens: 0,
        cost_usd_micros: providerCostUsdMicros({ model, inputTokens, outputTokens: 0 }),
        duration_ms: usage.durationMs,
        surface: "mcp",
        prompt_hash: promptHash,
        created_at: new Date().toISOString(),
      },
    ]);
    if (row === undefined) throw new Error("The usage row is missing.");
    // @oxagen/ai admits before the provider call, so a failed admission
    // refuses the call. Here the admission follows the answered request,
    // because a usage outbox that cannot be written must not stop a search.
    const id = await admitUsage(scope.orgId, scope.workspaceId);
    // No charge: the oxagen provider's embeddings are platform cost. A
    // response with no token count is staged as incomplete.
    await finalizeUsage({ id, row, complete: usage.tokens !== null });
  });
}

/**
 * The onUsage callback for the oxagen provider's embedder. Each call writes
 * one token_usage row in the background.
 */
export function searchUsageRecorder(scope: TenantScope, model: string): (usage: EmbedUsage) => void {
  return (usage) => {
    record(scope, model, usage).catch((error: unknown) => {
      logger.warn({ workspaceId: scope.workspaceId, errorName: error instanceof Error ? error.name : typeof error }, notRecorded);
    });
  };
}
