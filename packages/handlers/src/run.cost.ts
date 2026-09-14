// audit-exempt: read-only — answers one run's cost rollup row; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `get_run_cost` (ADR-058): the run's `cost.run_totals` row as the Run page's
// cost strip and Cost tab read it. `rollup: null` until the rollup job has
// rebuilt the run from its frames after its seal.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  runCostGet,
  type RunCostGetOutput,
} from "@oxagen/oxagen/contracts/run.cost";
import { cost, readRunTotalsByIds, type SpendScope } from "./spend.shared";

export type RunCostDeps = {
  readRunTotalsByIds: (
    scope: SpendScope,
    runIds: readonly string[],
  ) => ReturnType<typeof readRunTotalsByIds>;
};

export function createRunCostHandler(
  deps: RunCostDeps,
): CapabilityHandler<typeof runCostGet> {
  return async (input, ctx): Promise<RunCostGetOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const row = (await deps.readRunTotalsByIds(scope, [input.runId])).get(
      input.runId,
    );
    if (!row) return { runId: input.runId, rollup: null };
    return {
      runId: input.runId,
      rollup: {
        cost: cost(row.costMicros, row.currency, row.costBasis),
        tokens: row.tokens,
        cacheHitRate: row.cacheHitRate,
        turns: row.turns,
        steps: row.steps,
        modelCalls: row.modelCalls,
        toolCalls: row.toolCalls,
        retries: row.retries,
        productiveRatio: row.productiveRatio,
        byModel: row.breakdown.models.map((m) => ({
          model: m.model,
          provider: m.provider,
          calls: m.calls,
          cost: {
            micros: m.costMicros.toString(),
            currency: row.currency,
            basis: m.basis,
          },
          tokens: m.tokens,
        })),
        byTool: row.breakdown.tools,
        priceEntryIds: row.priceEntryIds,
        rolledUpAt: row.rolledUpAt.toISOString(),
      },
    };
  };
}

export const runCostHandler = createRunCostHandler({ readRunTotalsByIds });
