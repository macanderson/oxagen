import { describe, expect, it } from "vitest";
import { runCostGet } from "./run.cost";

const tokens = {
  input_uncached: 1834,
  cache_read: 12000,
  cache_write_5m: 0,
  cache_write_1h: 0,
  output: 412,
  reasoning: 0,
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
});
