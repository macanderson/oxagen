// search-usage.ts: meter the tokens the oxagen provider's search embeddings
// use (lane M15; ADR-217).
//
// Search entries embed outside @oxagen/ai (ADR-217, decision 1). This writes
// the token_usage row @oxagen/ai writes for its own embeddings: the tokens,
// the duration, the surface, the prompt hash, and the provider's cost. It
// charges no credits, because the oxagen provider's spend is platform cost.
// A custom provider bills the workspace's own account, so nothing meters it
// here. A failure is logged by its name and never fails a search or a
// publish.
import { admitUsage, finalizeUsage, providerCostUsdMicros, voidUsage } from "@oxagen/billing";
import type { EmbedMeter, EmbedUsage } from "@oxagen/mcp-studio";
import { hashPrompt, providerFromModelId, stampTokenUsage } from "@oxagen/telemetry";
import { runInTenantScope, type TenantScope } from "@oxagen/tenancy";
import { logger } from "../logger";

const notAdmitted = "The usage outbox could not admit a search embedding. Search and publish go on, and this request is not metered.";
const notRecorded = "The token count of a search embedding was not recorded. Search and publish go on.";
const notVoided = "A failed search embedding's admission could not be voided. It stays counted as incomplete.";

/** The meter for a request whose admission failed. It records nothing. */
const unmetered: EmbedMeter = { used: () => undefined, failed: () => undefined };

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function record(scope: TenantScope, model: string, id: string, usage: EmbedUsage): Promise<void> {
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
    // No charge: the oxagen provider's embeddings are platform cost. A
    // response with no token count is staged as incomplete.
    await finalizeUsage({ id, row, complete: usage.tokens !== null });
  });
}

/** Close the admission of a request that failed, so it stops counting as incomplete. */
async function discard(scope: TenantScope, id: string): Promise<void> {
  await runInTenantScope(scope, () =>
    voidUsage({ id, orgId: scope.orgId, workspaceId: scope.workspaceId, reason: "provider_call_failed" }),
  );
}

async function open(scope: TenantScope, model: string): Promise<EmbedMeter> {
  let id: string;
  try {
    id = await runInTenantScope(scope, () => admitUsage(scope.orgId, scope.workspaceId));
  } catch (error) {
    // @oxagen/ai refuses a call whose admission fails. A search goes on
    // without one, because a usage outbox that cannot be written must not
    // stop a search. The alert field makes unmetered searches visible.
    logger.error(
      { workspaceId: scope.workspaceId, alert: "billing_search_usage_failed_open", errorName: errorName(error) },
      notAdmitted,
    );
    return unmetered;
  }
  return {
    used(usage) {
      record(scope, model, id, usage).catch((error: unknown) => {
        logger.warn({ workspaceId: scope.workspaceId, errorName: errorName(error) }, notRecorded);
      });
    },
    failed() {
      discard(scope, id).catch((error: unknown) => {
        logger.error(
          { workspaceId: scope.workspaceId, usageId: id, alert: "billing_usage_void_failed", errorName: errorName(error) },
          notVoided,
        );
      });
    },
  };
}

/**
 * The meter for the oxagen provider's embedder. It admits each request to
 * the usage outbox before the request is sent, then finalizes the admission
 * in the background, or voids it when the request fails.
 */
export function searchUsageMeter(scope: TenantScope, model: string): () => Promise<EmbedMeter> {
  return () => open(scope, model);
}
