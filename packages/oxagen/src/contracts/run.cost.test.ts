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
      runCostGet.output.parse({
        runId: "tse_abc123",
        rollup: null,
        baseline: null,
      }).rollup,
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
      advancedSteps: null,
      unproductiveSteps: null,
      unproductiveCauses: null,
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
      byTool: [{ name: "Bash", calls: 5, resultTokens: null, cost: null }],
      priceEntryIds: ["0f2c2a3e-1b6a-4c1d-9c3e-1234567890ab"],
      rolledUpAt: "2026-09-14T10:06:31.000Z",
      isEstimate: false,
    };
    expect(
      runCostGet.output.parse({ runId: "tse_abc123", rollup, baseline: null })
        .rollup,
    ).toEqual(rollup);
    expect(
      runCostGet.output.safeParse({
        runId: "tse_abc123",
        rollup: { ...rollup, cacheHitRate: 2 },
        baseline: null,
      }).success,
    ).toBe(false);
    // A row built while the run was open is an estimate, and every row says
    // which it is (#3980).
    expect(
      runCostGet.output.parse({
        runId: "tse_abc123",
        rollup: { ...rollup, isEstimate: true },
        baseline: null,
      }).rollup?.isEstimate,
    ).toBe(true);
    const { isEstimate: _omitted, ...unlabelled } = rollup;
    expect(
      runCostGet.output.safeParse({
        runId: "tse_abc123",
        rollup: unlabelled,
        baseline: null,
      }).success,
    ).toBe(false);
    // A model group none of whose frames was priced carries no figure.
    expect(
      runCostGet.output.safeParse({
        runId: "tse_abc123",
        rollup: { ...rollup, byModel: [{ ...rollup.byModel[0], cost: null }] },
        baseline: null,
      }).success,
    ).toBe(true);
    expect(
      runCostGet.output.safeParse({
        runId: "tse_abc123",
        rollup: {
          ...rollup,
          byModel: [{ ...rollup.byModel[0], cost: { micros: "1" } }],
        },
        baseline: null,
      }).success,
    ).toBe(false);
  });

  it("carries graded steps with their causes, each tool's result tokens and cost, and the agent's baseline (#3984, #3892)", () => {
    const graded = {
      cost: usd("41265"),
      tokens,
      cacheHitRate: null,
      turns: 3,
      steps: 9,
      modelCalls: 4,
      toolCalls: 5,
      retries: 1,
      productiveRatio: 7 / 9,
      advancedSteps: 7,
      unproductiveSteps: 2,
      unproductiveCauses: { failed: 1, repeated: 0, retried: 1 },
      byModel: [],
      byTool: [
        {
          name: "Read",
          calls: 3,
          resultTokens: 1200,
          cost: { micros: "3600", currency: "USD", basis: "estimated" },
        },
      ],
      priceEntryIds: [],
      rolledUpAt: "2026-09-14T10:06:31.000Z",
      isEstimate: false,
    };
    const baseline = {
      windowDays: 30,
      before: "2026-09-14T10:00:00.000Z",
      runs: 12,
      medianCost: usd("38000"),
      productiveRatio: 0.71,
    };
    const answer = { runId: "tse_abc123", rollup: graded, baseline };
    expect(runCostGet.output.parse(answer)).toEqual(answer);
    // Fewer priced or graded runs than the minimum answer null figures.
    expect(
      runCostGet.output.safeParse({
        ...answer,
        baseline: { ...baseline, medianCost: null, productiveRatio: null },
      }).success,
    ).toBe(true);
    // The window is 30 days, a baseline counts at least one run, and the key
    // is required (negative).
    expect(
      runCostGet.output.safeParse({
        ...answer,
        baseline: { ...baseline, windowDays: 7 },
      }).success,
    ).toBe(false);
    expect(
      runCostGet.output.safeParse({ ...answer, baseline: { ...baseline, runs: 0 } })
        .success,
    ).toBe(false);
    const { baseline: _unread, ...unanswered } = answer;
    expect(runCostGet.output.safeParse(unanswered).success).toBe(false);
    // A cause outside the three, or a tool figure without its key (negative).
    expect(
      runCostGet.output.safeParse({
        ...answer,
        rollup: {
          ...graded,
          unproductiveCauses: { failed: 1, repeated: 0, retried: 1, slow: 0 },
        },
      }).success,
    ).toBe(false);
    expect(
      runCostGet.output.safeParse({
        ...answer,
        rollup: { ...graded, byTool: [{ name: "Read", calls: 3 }] },
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
        advancedSteps: null,
        unproductiveSteps: null,
        unproductiveCauses: null,
        byModel: [m],
        byTool: [],
        priceEntryIds: [],
        rolledUpAt: "2026-09-14T10:06:31.000Z",
        isEstimate: false,
      },
      baseline: null,
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
