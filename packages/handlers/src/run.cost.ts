// audit-exempt: read-only — answers one run's cost rollup row; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `get_run_cost` (ADR-060): the run's `cost.run_totals` row as the Run page's
// cost strip and Cost tab read it. The row is rebuilt while the run records
// frames and again at its seal; one built from an open run answers
// `isEstimate: true` (#3980). `rollup: null` until the rollup job has built
// the row at all.
// Until then a wrapped run answers `provisional`: the per-model figures
// ingest has folded so far, so the page shows live spend rather than nothing.
//
// Beside the row it answers the agent's baseline (#3984, ADR-199): the median
// cost and productive ratio of the agent's sealed runs in the 30 days before
// this run started. Each tool's result cost is an estimate of input the run's
// cost already counts, so it always carries the `estimated` basis. So does
// the standing context by source (#4537, spec detector 2).
//
// It also answers each loop that reached the workspace's no-progress limit
// (#4490, spec detector 1), from `cost.no_progress_hits`: the Cost tab draws
// one line per loop.
import {
  standingContextBySource,
  standingSourcesOf,
  type StandingSourcePrice,
} from "@oxagen/billing";
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  RUN_NO_PROGRESS_PAUSE_BLOCKS,
  runCostGet,
  type RunCostBaseline,
  type RunCostByClass,
  type RunCostGetOutput,
  type RunCostNoProgressHit,
  type RunCostProvisional,
  type RunCostStandingContext,
} from "@oxagen/oxagen/contracts/run.cost";
import {
  costBasisSchema,
  type Cost,
  type CostBasis,
} from "@oxagen/oxagen/contracts/spend.shared";
import { schema, withTenantDb } from "@oxagen/database";
import { and, asc, eq, isNull } from "drizzle-orm";
import { type BaselineRun, readRunCostBaseline } from "./lib/run-cost-baseline";
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
  /** The agent's baseline for a run that has a row; null when it has none. */
  readBaseline: (
    scope: SpendScope,
    run: BaselineRun,
  ) => Promise<RunCostBaseline | null>;
  /** The run's no-progress hits; absent, the answer carries none. */
  readNoProgressHits?: (
    scope: SpendScope,
    runId: string,
  ) => Promise<RunCostNoProgressHit[]>;
};

const noProgressHits = schema.noProgressHits;

/** The most hits one read answers; a run holds one row per loop. */
export const RUN_NO_PROGRESS_HITS_MAX = 100;

type NoProgressHitRow = {
  tool: string;
  loop: number;
  repeats: number;
  limitRepeats: number;
  atCall: number;
  mode: string;
  outcome: string;
  pauseBlock: string | null;
  detectedAt: Date;
};

const pauseBlockOf = (
  value: string | null,
): RunCostNoProgressHit["pauseBlock"] =>
  (RUN_NO_PROGRESS_PAUSE_BLOCKS as readonly string[]).includes(value ?? "")
    ? (value as RunCostNoProgressHit["pauseBlock"])
    : null;

/**
 * A stored hit on the wire. The table's checks hold the mode, outcome, and
 * block to the contract's sets, so an unknown value here means a newer
 * writer: it reads as observe, `would_pause`, and no block, the reading that
 * claims the least.
 */
export function noProgressHitOf(row: NoProgressHitRow): RunCostNoProgressHit {
  const mode = row.mode === "enforced" ? "enforced" : "observe";
  const outcome =
    mode === "enforced" && row.outcome === "paused" ? "paused" : "would_pause";
  return {
    tool: row.tool,
    loop: row.loop,
    repeats: row.repeats,
    limit: row.limitRepeats,
    atCall: row.atCall,
    mode,
    outcome,
    pauseBlock:
      mode === "enforced" && outcome === "would_pause"
        ? pauseBlockOf(row.pauseBlock)
        : null,
    detectedAt: row.detectedAt.toISOString(),
  };
}

/** The run's `cost.no_progress_hits` rows, in the order each loop reached the limit. */
export async function readNoProgressHits(
  scope: SpendScope,
  runId: string,
): Promise<RunCostNoProgressHit[]> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        tool: noProgressHits.tool,
        loop: noProgressHits.loop,
        repeats: noProgressHits.repeats,
        limitRepeats: noProgressHits.limitRepeats,
        atCall: noProgressHits.atCall,
        mode: noProgressHits.mode,
        outcome: noProgressHits.outcome,
        pauseBlock: noProgressHits.pauseBlock,
        detectedAt: noProgressHits.detectedAt,
      })
      .from(noProgressHits)
      .where(
        and(
          eq(noProgressHits.orgId, scope.orgId),
          eq(noProgressHits.workspaceId, scope.workspaceId),
          eq(noProgressHits.runId, runId),
        ),
      )
      .orderBy(asc(noProgressHits.atCall), asc(noProgressHits.tool))
      .limit(RUN_NO_PROGRESS_HITS_MAX),
  );
  return rows.map(noProgressHitOf);
}

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
    server_tool_request: figure(byClass.server_tool_request),
  };
}

/**
 * The context every model call after the first re-sent, by source. The
 * recorder estimates the tokens, so every figure carries the `estimated`
 * basis. Null when the row reports no source, which is every row the rollup
 * built before the sources were recorded (#4493).
 */
export function standingContextOf(
  row: Parameters<typeof standingContextBySource>[0] & {
    currency: string;
  },
): RunCostStandingContext | null {
  const sources = standingContextBySource(row, standingSourcesOf(row));
  if (sources === null) return null;
  const wire = (source: StandingSourcePrice | null) =>
    source === null
      ? null
      : {
          resentTokens: source.resentTokens,
          cost: cost(source.micros, row.currency, "estimated"),
        };
  return {
    toolDefinitions: wire(sources.toolDefinitionTokens),
    steering: wire(sources.steeringTokens),
    contextFrames: wire(sources.contextFrameTokens),
  };
}

export function createRunCostHandler(
  deps: RunCostDeps,
): CapabilityHandler<typeof runCostGet> {
  return async (input, ctx): Promise<RunCostGetOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const [rows, hits] = await Promise.all([
      deps.readRunTotalsByIds(scope, [input.runId]),
      deps.readNoProgressHits
        ? deps.readNoProgressHits(scope, input.runId)
        : null,
    ]);
    const loops = hits === null ? {} : { noProgressHits: hits };
    const row = rows.get(input.runId);
    if (!row) {
      // With no row there is no agent key or start to read a baseline for.
      const provisional = deps.readProvisional
        ? await deps.readProvisional(scope, input.runId)
        : null;
      return provisional === null
        ? { runId: input.runId, rollup: null, baseline: null, ...loops }
        : {
            runId: input.runId,
            rollup: null,
            provisional,
            baseline: null,
            ...loops,
          };
    }
    const baseline = await deps.readBaseline(scope, {
      runId: row.runId,
      agentKey: row.agentKey,
      startedAt: row.startedAt,
      currency: row.currency,
    });
    // The three grade fields travel together: a row rolled up before the
    // steps were graded answers null for all of them until its next rollup.
    const causes = row.breakdown.steps;
    const graded =
      row.advancedSteps !== null &&
      row.unproductiveSteps !== null &&
      causes !== null;
    return {
      runId: input.runId,
      baseline,
      ...loops,
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
        advancedSteps: graded ? row.advancedSteps : null,
        unproductiveSteps: graded ? row.unproductiveSteps : null,
        unproductiveCauses: graded ? causes : null,
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
        // A row rolled up before result tokens were recorded carries neither
        // figure (#3892). The cost is the result tokens at the run's input
        // rate: an estimate whatever basis the run's own figure has.
        byTool: row.breakdown.tools.map((t) => ({
          name: t.name,
          calls: t.calls,
          resultTokens: t.resultTokens,
          cost: cost(t.costMicros, row.currency, "estimated"),
        })),
        standingContext: standingContextOf(row),
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
  readBaseline: readRunCostBaseline,
  readNoProgressHits,
});
