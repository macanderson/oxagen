import { describe, expect, it } from "vitest";
import { runCostGet } from "./run.cost";

const usd = (micros: string) => ({
  micros,
  currency: "USD",
  basis: "client_attested",
});
const costByClass = {
  input_uncached: usd("5502"),
  cache_read: usd("3600"),
  cache_write_5m: usd("0"),
  cache_write_1h: usd("0"),
  output: usd("32163"),
  reasoning: usd("0"),
  server_tool_request: usd("0"),
};

const tokens = {
  input_uncached: 1834,
  cache_read: 12000,
  cache_write_5m: 0,
  cache_write_1h: 0,
  output: 412,
  reasoning: 0,
  server_tool_request: 0,
};

describe("get_run_cost contract", () => {
  it("is a console read keyed on a run public id", () => {
    expect(runCostGet.noBillingGate).toBe(true);
    expect(runCostGet.mutates).toBe(false);
    expect(runCostGet.input.safeParse({ runId: "run_1" }).success).toBe(false);
    expect(runCostGet.input.safeParse({ runId: "tse_abc123" }).success).toBe(
      true,
    );
  });

  it("is a low-risk read the in-app agent may call without approval", () => {
    expect(runCostGet.surfaces).toEqual(["api", "mcp", "agent"]);
    expect(runCostGet.agent).toEqual({
      requiresApproval: false,
      riskLevel: "low",
      category: "run",
    });
  });

  it("answers null until the rollup covers the run, and a full row after", () => {
    expect(
      runCostGet.output.parse({ runId: "tse_abc123", rollup: null }).rollup,
    ).toBe(null);
    const rollup = {
      cost: { micros: "41265", currency: "USD", basis: "client_attested" },
      tokens,
      cacheHitRate: 0.8674,
      turns: 3,
      steps: 9,
      modelCalls: 4,
      toolCalls: 5,
      retries: 0,
      productiveRatio: null,
      byModel: [
        {
          model: "claude-sonnet-5",
          provider: "anthropic",
          calls: 4,
          cost: { micros: "41265", currency: "USD", basis: "client_attested" },
          tokens,
          costByClass,
          cacheSaving: usd("32400"),
          hasUnpriced: false,
        },
      ],
      byTool: [{ name: "Bash", calls: 5 }],
      priceEntryIds: ["0f2c2a3e-1b6a-4c1d-9c3e-1234567890ab"],
      rolledUpAt: "2026-09-14T10:06:31.000Z",
      isEstimate: false,
    };
    expect(
      runCostGet.output.parse({ runId: "tse_abc123", rollup }).rollup,
    ).toEqual(rollup);
    expect(
      runCostGet.output.safeParse({
        runId: "tse_abc123",
        rollup: { ...rollup, cacheHitRate: 2 },
      }).success,
    ).toBe(false);
    // A row built while the run was open is an estimate, and every row says
    // which it is (#3980).
    expect(
      runCostGet.output.parse({
        runId: "tse_abc123",
        rollup: { ...rollup, isEstimate: true },
      }).rollup?.isEstimate,
    ).toBe(true);
    const { isEstimate: _omitted, ...unlabelled } = rollup;
    expect(
      runCostGet.output.safeParse({ runId: "tse_abc123", rollup: unlabelled })
        .success,
    ).toBe(false);
    // A model group none of whose frames was priced carries no figure.
    expect(
      runCostGet.output.safeParse({
        runId: "tse_abc123",
        rollup: { ...rollup, byModel: [{ ...rollup.byModel[0], cost: null }] },
      }).success,
    ).toBe(true);
    expect(
      runCostGet.output.safeParse({
        runId: "tse_abc123",
        rollup: {
          ...rollup,
          byModel: [{ ...rollup.byModel[0], cost: { micros: "1" } }],
        },
      }).success,
    ).toBe(false);
  });

  it("carries each model's recorded class split, cache saving and unpriced flag (#4069)", () => {
    const model = {
      model: "claude-sonnet-5",
      provider: "anthropic",
      calls: 4,
      cost: usd("41265"),
      tokens,
      costByClass,
      cacheSaving: usd("32400"),
      hasUnpriced: false,
    };
    const rollup = (m: Record<string, unknown>) => ({
      runId: "tse_abc123",
      rollup: {
        cost: usd("41265"),
        tokens,
        cacheHitRate: null,
        turns: null,
        steps: 4,
        modelCalls: 4,
        toolCalls: 0,
        retries: null,
        productiveRatio: null,
        byModel: [m],
        byTool: [],
        priceEntryIds: [],
        rolledUpAt: "2026-09-14T10:06:31.000Z",
        isEstimate: false,
      },
    });
    const ok = (m: Record<string, unknown>) =>
      runCostGet.output.safeParse(rollup(m)).success;
    expect(ok(model)).toBe(true);
    // A saving not recorded, and a model none of whose frames priced.
    expect(ok({ ...model, cacheSaving: null })).toBe(true);
    expect(
      ok({ ...model, cost: null, costByClass: null, hasUnpriced: true }),
    ).toBe(true);
    // Every class carries money and a basis, and every class is required.
    const { reasoning: _dropped, ...withoutReasoning } = costByClass;
    expect(ok({ ...model, costByClass: withoutReasoning })).toBe(false);
    expect(
      ok({
        ...model,
        costByClass: { ...costByClass, output: { micros: "1" } },
      }),
    ).toBe(false);
    const { hasUnpriced: _flag, ...unflagged } = model;
    expect(ok(unflagged)).toBe(false);
  });
});
