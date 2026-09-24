// audit-exempt: read-only — answers one run's cost rollup row; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `get_run_cost` (ADR-060): the run's `cost.run_totals` row as the Run page's
// cost strip and Cost tab read it. The row is rebuilt while the run records
// frames and again at its seal; one built from an open run answers
// `isEstimate: true` (#3980). `rollup: null` until the rollup job has built
// the row at all.
// Until then a wrapped run answers `provisional`: the per-model figures
// ingest has folded so far, so the page shows live spend rather than nothing.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  runCostGet,
  type RunCostByClass,
  type RunCostGetOutput,
  type RunCostProvisional,
} from "@oxagen/oxagen/contracts/run.cost";
import {
  costBasisSchema,
  type Cost,
  type CostBasis,
} from "@oxagen/oxagen/contracts/spend.shared";
import { schema, withTenantDb } from "@oxagen/database";
import { and, asc, eq, isNull } from "drizzle-orm";
import { cost, readRunTotalsByIds, type SpendScope } from "./spend.shared";

export type RunCostDeps = {
  readRunTotalsByIds: (
    scope: SpendScope,
    runIds: readonly string[],
  ) => ReturnType<typeof readRunTotalsByIds>;
  /** The running figures for a wrapped run; null for any other run. */
  readProvisional?: (
    scope: SpendScope,
    runId: string,
  ) => Promise<RunCostProvisional | null>;
};

const sessions = schema.tachoSessions;
const sessionModels = schema.tachoSessionModels;

/**
 * The root session's `session_models` rows and tool-call counter. Ingest adds
 * each counted `llm_call` frame to these as it lands, so they read the run as
 * of its last event. A model whose calls reported no cost answers a null cost
 * rather than a zero, and a basis outside the contract's set reads as
 * `client_attested`, since the figure came from the harness.
 */
export async function readProvisionalCost(
  scope: SpendScope,
  runId: string,
): Promise<RunCostProvisional | null> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        toolCalls: sessions.numToolCalls,
        lastEventAt: sessions.lastEventAt,
        model: sessionModels.model,
        provider: sessionModels.provider,
        requests: sessionModels.requests,
        costMicros: sessionModels.costMicros,
        costBasis: sessionModels.costBasis,
      })
      .from(sessions)
      .leftJoin(
        sessionModels,
        and(
          eq(sessionModels.sessionId, sessions.id),
          eq(sessionModels.orgId, sessions.orgId),
        ),
      )
      .where(
        and(
          eq(sessions.publicId, runId),
          eq(sessions.orgId, scope.orgId),
          eq(sessions.workspaceId, scope.workspaceId),
          isNull(sessions.parentSessionUuid),
        ),
      )
      .orderBy(asc(sessionModels.model)),
  );
  return provisionalOf(rows);
}

type ProvisionalRow = {
  toolCalls: number;
  lastEventAt: Date;
  model: string | null;
  provider: string | null;
  requests: number | null;
  costMicros: number | null;
  costBasis: string | null;
};

/** Folds the joined rows into the contract's shape; null when no session matched. */
export function provisionalOf(
  rows: readonly ProvisionalRow[],
): RunCostProvisional | null {
  const first = rows[0];
  if (first === undefined) return null;
  const byModel: RunCostProvisional["byModel"] = [];
  for (const row of rows) {
    if (row.model === null) continue;
    const micros = row.costMicros ?? 0;
    byModel.push({
      model: row.model,
      provider: row.provider,
      calls: row.requests ?? 0,
      cost:
        micros > 0
          ? cost(
              BigInt(micros),
              "USD",
              costBasisSchema.safeParse(row.costBasis).data ??
                "client_attested",
            )
          : null,
    });
  }
  return {
    byModel,
    toolCalls: first.toolCalls,
    asOf: first.lastEventAt.toISOString(),
  };
}

/**
 * A model's recorded class split on the wire, every class carrying the
 * model's basis. Null when the model has no basis, which is when none of its
 * frames was priced, so the split is null exactly when the model's cost is.
 */
export function costByClassOf(
  byClass: Record<keyof RunCostByClass, bigint>,
  currency: string,
  basis: CostBasis | null,
): RunCostByClass | null {
  if (basis === null) return null;
  const figure = (micros: bigint): Cost => ({
    micros: micros.toString(),
    currency,
    basis,
  });
  return {
    input_uncached: figure(byClass.input_uncached),
    cache_read: figure(byClass.cache_read),
    cache_write_5m: figure(byClass.cache_write_5m),
    cache_write_1h: figure(byClass.cache_write_1h),
    output: figure(byClass.output),
    reasoning: figure(byClass.reasoning),
  };
}

export function createRunCostHandler(
  deps: RunCostDeps,
): CapabilityHandler<typeof runCostGet> {
  return async (input, ctx): Promise<RunCostGetOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const row = (await deps.readRunTotalsByIds(scope, [input.runId])).get(
      input.runId,
    );
    if (!row) {
      const provisional = deps.readProvisional
        ? await deps.readProvisional(scope, input.runId)
        : null;
      return provisional === null
        ? { runId: input.runId, rollup: null }
        : { runId: input.runId, rollup: null, provisional };
    }
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
          cost: cost(m.costMicros, row.currency, m.basis),
          tokens: m.tokens,
          costByClass: costByClassOf(m.costByClass, row.currency, m.basis),
          // The rollup recorded it at each frame's instant; a row rolled up
          // before it did reads null here, never a zero.
          cacheSaving: cost(m.cacheSavingMicros, row.currency, m.basis),
          hasUnpriced: m.hasUnpriced,
        })),
        byTool: row.breakdown.tools,
        priceEntryIds: row.priceEntryIds,
        rolledUpAt: row.rolledUpAt.toISOString(),
        isEstimate: row.sealedAt === null,
      },
    };
  };
}

export const runCostHandler = createRunCostHandler({
  readRunTotalsByIds,
  readProvisional: readProvisionalCost,
});
