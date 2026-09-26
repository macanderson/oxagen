import {
  runCostGet,
  type RunCostBaseline,
} from "@oxagen/oxagen/contracts/run.cost";
import { describe, expect, it, vi } from "vitest";
import type { BaselineRun } from "./lib/run-cost-baseline";
import { createRunCostHandler, provisionalOf } from "./run.cost";
import { ctx, pricedRun, run, SCOPE } from "./spend.test-support";

const ROLLED_UP_AT = new Date("2026-09-10T12:31:00.000Z");

/** No baseline: what an agent with a thin history answers. */
const noBaseline = async (): Promise<RunCostBaseline | null> => null;

function harness(
  rows: ReturnType<typeof run>[],
  baseline: RunCostBaseline | null = null,
) {
  const readRunTotalsByIds = vi.fn(async (_scope, ids: readonly string[]) => {
    const found = rows.filter((r) => ids.includes(r.runId));
    return new Map(
      found.map((r) => [r.runId, { ...r, rolledUpAt: ROLLED_UP_AT }]),
    );
  });
  const readBaseline = vi.fn(
    async (_scope, _run: BaselineRun): Promise<RunCostBaseline | null> =>
      baseline,
  );
  return {
    handler: createRunCostHandler({ readRunTotalsByIds, readBaseline }),
    readRunTotalsByIds,
    readBaseline,
  };
}

describe("get_run_cost", () => {
  it("reads the row by the caller's scope and the run id", async () => {
    const row = pricedRun(10n);
    const h = harness([row]);
    await h.handler({ runId: row.runId }, ctx());
    expect(h.readRunTotalsByIds).toHaveBeenCalledWith(SCOPE, [row.runId]);
  });

  it("answers rollup: null for a run the rollup has not reached", async () => {
    const h = harness([]);
    const out = await h.handler({ runId: "tse_0000000000000000000001" }, ctx());
    expect(out).toEqual({
      runId: "tse_0000000000000000000001",
      rollup: null,
      baseline: null,
    });
    expect(() => runCostGet.output.parse(out)).not.toThrow();
  });

  it("answers the row's cost with its basis, tokens, counts, breakdown and price entries", async () => {
    const row = pricedRun(1_250n, {
      costBasis: "gateway_observed",
      cacheHitRate: 0.25,
      priceEntryIds: ["0192d4a8-7c1e-7a00-8000-0000000000e1"],
      productiveRatio: 0.5,
    });
    const h = harness([row]);
    const out = await h.handler({ runId: row.runId }, ctx());
    expect(out.rollup).toEqual({
      cost: { micros: "1250", currency: "USD", basis: "gateway_observed" },
      tokens: row.tokens,
      cacheHitRate: 0.25,
      turns: 3,
      steps: 4,
      modelCalls: 2,
      toolCalls: 2,
      retries: 0,
      productiveRatio: 0.5,
      advancedSteps: null,
      unproductiveSteps: null,
      unproductiveCauses: null,
      byModel: [
        {
          model: "claude-sonnet-5",
          provider: "anthropic",
          calls: 2,
          cost: { micros: "1250", currency: "USD", basis: "gateway_observed" },
          tokens: row.breakdown.models[0]?.tokens,
          costByClass: {
            input_uncached: {
              micros: "1250",
              currency: "USD",
              basis: "gateway_observed",
            },
            cache_read: {
              micros: "0",
              currency: "USD",
              basis: "gateway_observed",
            },
            cache_write_5m: {
              micros: "0",
              currency: "USD",
              basis: "gateway_observed",
            },
            cache_write_1h: {
              micros: "0",
              currency: "USD",
              basis: "gateway_observed",
            },
            output: { micros: "0", currency: "USD", basis: "gateway_observed" },
            reasoning: {
              micros: "0",
              currency: "USD",
              basis: "gateway_observed",
            },
          },
          cacheSaving: {
            micros: "0",
            currency: "USD",
            basis: "gateway_observed",
          },
          hasUnpriced: false,
        },
      ],
      byTool: [{ name: "Read", calls: 2, resultTokens: null, cost: null }],
      priceEntryIds: ["0192d4a8-7c1e-7a00-8000-0000000000e1"],
      rolledUpAt: ROLLED_UP_AT.toISOString(),
      // The fixture's row was rebuilt after the run sealed.
      isEstimate: false,
    });
    expect(() => runCostGet.output.parse(out)).not.toThrow();
  });

  it("answers each model's recorded class split and cache saving, not a repricing (#4069)", async () => {
    const row = pricedRun(4_000n, { cacheWriteMicros: 1_000n });
    const [model] = row.breakdown.models;
    model!.cacheSavingMicros = 2_700n;
    const out = await harness([row]).handler({ runId: row.runId }, ctx());
    const [wire] = out.rollup!.byModel;
    expect(wire!.costByClass?.input_uncached.micros).toBe("3000");
    expect(wire!.costByClass?.cache_write_5m.micros).toBe("1000");
    expect(wire!.cacheSaving).toEqual({
      micros: "2700",
      currency: "USD",
      basis: "client_attested",
    });
    expect(wire!.hasUnpriced).toBe(false);
    expect(() => runCostGet.output.parse(out)).not.toThrow();
  });

  it("answers cacheSaving: null for a row rolled up before the saving was recorded", async () => {
    const row = pricedRun(4_000n);
    row.breakdown.models[0]!.cacheSavingMicros = null;
    const out = await harness([row]).handler({ runId: row.runId }, ctx());
    expect(out.rollup!.byModel[0]!.cacheSaving).toBeNull();
    // The rest of the row still reads: only the saving is not recorded.
    expect(out.rollup!.byModel[0]!.costByClass).not.toBeNull();
    expect(() => runCostGet.output.parse(out)).not.toThrow();
  });

  it("answers no class split and no saving for a model none of whose frames priced, and says it went unpriced", async () => {
    const row = pricedRun(4_000n);
    row.breakdown.models.push({
      ...row.breakdown.models[0]!,
      model: "mystery-9",
      costMicros: null,
      basis: null,
      cacheSavingMicros: null,
      hasUnpriced: true,
    });
    const out = await harness([row]).handler({ runId: row.runId }, ctx());
    const mystery = out.rollup!.byModel.find((m) => m.model === "mystery-9");
    expect(mystery).toMatchObject({
      cost: null,
      costByClass: null,
      cacheSaving: null,
      hasUnpriced: true,
    });
    expect(() => runCostGet.output.parse(out)).not.toThrow();
  });

  it("marks a row built while the run was open as an estimate (#3980)", async () => {
    const row = pricedRun(900n, { sealedAt: null });
    const h = harness([row]);
    const out = await h.handler({ runId: row.runId }, ctx());
    expect(out.rollup?.isEstimate).toBe(true);
    expect(out.rollup?.cost).toEqual({
      micros: "900",
      currency: "USD",
      basis: "client_attested",
    });
    expect(() => runCostGet.output.parse(out)).not.toThrow();
  });

  it("answers cost: null on a row no frame priced, with its counts intact", async () => {
    const row = run({ steps: 1, modelCalls: 0, toolCalls: 1 });
    const h = harness([row]);
    const out = await h.handler({ runId: row.runId }, ctx());
    expect(out.rollup?.cost).toBeNull();
    expect(out.rollup?.cacheHitRate).toBeNull();
    expect(out.rollup?.steps).toBe(1);
    expect(out.rollup?.byModel).toEqual([]);
    expect(() => runCostGet.output.parse(out)).not.toThrow();
  });

  it("answers the wrapped run's provisional figures while no rollup row exists", async () => {
    const provisional = {
      byModel: [
        {
          model: "claude-sonnet-5",
          provider: "anthropic",
          calls: 3,
          cost: {
            micros: "900",
            currency: "USD",
            basis: "client_attested" as const,
          },
        },
      ],
      toolCalls: 4,
      asOf: "2026-09-23T10:00:00.000Z",
    };
    const readProvisional = vi.fn(async () => provisional);
    const handler = createRunCostHandler({
      readRunTotalsByIds: async () => new Map(),
      readProvisional,
      readBaseline: noBaseline,
    });
    const runId = "tse_0000000000000000000002";
    const out = await handler({ runId }, ctx());
    expect(readProvisional).toHaveBeenCalledWith(SCOPE, runId);
    expect(out).toEqual({ runId, rollup: null, provisional, baseline: null });
    expect(() => runCostGet.output.parse(out)).not.toThrow();
  });

  it("does not read provisional figures once the rollup row exists", async () => {
    const row = pricedRun(10n);
    const readProvisional = vi.fn(async () => null);
    const handler = createRunCostHandler({
      readRunTotalsByIds: async () =>
        new Map([[row.runId, { ...row, rolledUpAt: ROLLED_UP_AT }]]),
      readProvisional,
      readBaseline: noBaseline,
    });
    const out = await handler({ runId: row.runId }, ctx());
    expect(readProvisional).not.toHaveBeenCalled();
    expect(out).not.toHaveProperty("provisional");
  });

  it("answers rollup: null alone when no wrapped session matches", async () => {
    const readBaseline = vi.fn(noBaseline);
    const handler = createRunCostHandler({
      readRunTotalsByIds: async () => new Map(),
      readProvisional: async () => null,
      readBaseline,
    });
    const runId = "run_0000000000000000000003";
    expect(await handler({ runId }, ctx())).toEqual({
      runId,
      rollup: null,
      baseline: null,
    });
    // No row names an agent or a start, so there is no baseline to read.
    expect(readBaseline).not.toHaveBeenCalled();
  });
});

describe("get_run_cost steps and tool costs (#3984, #3892)", () => {
  it("answers the graded steps and why the unproductive ones made no progress", async () => {
    const row = pricedRun(1_250n, {
      steps: 4,
      productiveRatio: 0.5,
      advancedSteps: 2,
      unproductiveSteps: 2,
    });
    row.breakdown.steps = { failed: 1, repeated: 0, retried: 1 };
    const out = await harness([row]).handler({ runId: row.runId }, ctx());
    expect(out.rollup).toMatchObject({
      steps: 4,
      productiveRatio: 0.5,
      advancedSteps: 2,
      unproductiveSteps: 2,
      unproductiveCauses: { failed: 1, repeated: 0, retried: 1 },
    });
    const { rollup } = out;
    expect(
      (rollup?.advancedSteps ?? 0) + (rollup?.unproductiveSteps ?? 0),
    ).toBe(rollup?.steps);
    expect(() => runCostGet.output.parse(out)).not.toThrow();
  });

  it("answers all three grade fields null on a row rolled up before grading", async () => {
    // The columns were filled but the jsonb has no causes: the three travel
    // together, so none is answered.
    const row = pricedRun(1_250n, { advancedSteps: 3, unproductiveSteps: 1 });
    const out = await harness([row]).handler({ runId: row.runId }, ctx());
    expect(out.rollup).toMatchObject({
      advancedSteps: null,
      unproductiveSteps: null,
      unproductiveCauses: null,
    });
    expect(() => runCostGet.output.parse(out)).not.toThrow();
  });

  it("prices each tool's result tokens as an estimate, whatever the run's own basis", async () => {
    const row = pricedRun(9_000n, { costBasis: "gateway_observed" });
    row.breakdown.tools = [
      { name: "Grep", calls: 1, resultTokens: null, costMicros: null },
      { name: "Read", calls: 2, resultTokens: 1_200, costMicros: 3_600n },
    ];
    const out = await harness([row]).handler({ runId: row.runId }, ctx());
    expect(out.rollup?.cost?.basis).toBe("gateway_observed");
    expect(out.rollup?.byTool).toEqual([
      { name: "Grep", calls: 1, resultTokens: null, cost: null },
      {
        name: "Read",
        calls: 2,
        resultTokens: 1_200,
        cost: { micros: "3600", currency: "USD", basis: "estimated" },
      },
    ]);
    expect(() => runCostGet.output.parse(out)).not.toThrow();
  });
});

describe("get_run_cost baseline (#3984)", () => {
  const baseline: RunCostBaseline = {
    windowDays: 30,
    before: "2026-09-10T12:00:00.000Z",
    runs: 12,
    medianCost: { micros: "2890000", currency: "USD", basis: "mixed" },
    productiveRatio: 0.62,
  };

  it("reads the agent's baseline for the run's agent, start and currency", async () => {
    const row = pricedRun(4_130_000n);
    const h = harness([row], baseline);
    const out = await h.handler({ runId: row.runId }, ctx());
    expect(h.readBaseline).toHaveBeenCalledWith(SCOPE, {
      runId: row.runId,
      agentKey: "acme.core.cc",
      startedAt: row.startedAt,
      currency: "USD",
    });
    expect(out.baseline).toEqual(baseline);
    expect(() => runCostGet.output.parse(out)).not.toThrow();
  });

  it("answers baseline: null when the agent's history is too thin", async () => {
    const row = pricedRun(4_130_000n);
    const out = await harness([row], null).handler({ runId: row.runId }, ctx());
    expect(out.baseline).toBeNull();
    expect(out.rollup).not.toBeNull();
    expect(() => runCostGet.output.parse(out)).not.toThrow();
  });
});

describe("provisionalOf", () => {
  const at = new Date("2026-09-23T10:00:00.000Z");
  const base = { toolCalls: 7, lastEventAt: at };

  it("answers null when no session matched", () => {
    expect(provisionalOf([])).toBeNull();
  });

  it("answers an empty model list for a session with no model rows yet", () => {
    expect(
      provisionalOf([
        {
          ...base,
          model: null,
          provider: null,
          requests: null,
          costMicros: null,
          costBasis: null,
        },
      ]),
    ).toEqual({ byModel: [], toolCalls: 7, asOf: at.toISOString() });
  });

  it("keeps a known basis, reads an unknown one as client_attested, and nulls a zero cost", () => {
    const out = provisionalOf([
      {
        ...base,
        model: "claude-opus-5-5",
        provider: "anthropic",
        requests: 2,
        costMicros: 1500,
        costBasis: "gateway_observed",
      },
      {
        ...base,
        model: "claude-sonnet-5",
        provider: null,
        requests: 1,
        costMicros: 40,
        costBasis: "harness",
      },
      {
        ...base,
        model: "gpt-5",
        provider: "openai",
        requests: 1,
        costMicros: 0,
        costBasis: null,
      },
    ]);
    expect(out?.byModel).toEqual([
      {
        model: "claude-opus-5-5",
        provider: "anthropic",
        calls: 2,
        cost: { micros: "1500", currency: "USD", basis: "gateway_observed" },
      },
      {
        model: "claude-sonnet-5",
        provider: null,
        calls: 1,
        cost: { micros: "40", currency: "USD", basis: "client_attested" },
      },
      { model: "gpt-5", provider: "openai", calls: 1, cost: null },
    ]);
    expect(() =>
      runCostGet.output.parse({
        runId: "tse_0000000000000000000004",
        rollup: null,
        provisional: out,
        baseline: null,
      }),
    ).not.toThrow();
  });
});
