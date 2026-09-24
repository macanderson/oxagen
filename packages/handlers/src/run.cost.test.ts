import { runCostGet } from "@oxagen/oxagen/contracts/run.cost";
import { describe, expect, it, vi } from "vitest";
import { createRunCostHandler } from "./run.cost";
import { ctx, pricedRun, run, SCOPE } from "./spend.test-support";

const ROLLED_UP_AT = new Date("2026-09-10T12:31:00.000Z");

function harness(rows: ReturnType<typeof run>[]) {
  const readRunTotalsByIds = vi.fn(async (_scope, ids: readonly string[]) => {
    const found = rows.filter((r) => ids.includes(r.runId));
    return new Map(
      found.map((r) => [r.runId, { ...r, rolledUpAt: ROLLED_UP_AT }]),
    );
  });
  return {
    handler: createRunCostHandler({ readRunTotalsByIds }),
    readRunTotalsByIds,
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
    expect(out).toEqual({ runId: "tse_0000000000000000000001", rollup: null });
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
      byModel: [
        {
          model: "claude-sonnet-5",
          provider: "anthropic",
          calls: 2,
          cost: { micros: "1250", currency: "USD", basis: "gateway_observed" },
          tokens: row.breakdown.models[0]?.tokens,
        },
      ],
      byTool: [{ name: "Read", calls: 2 }],
      priceEntryIds: ["0192d4a8-7c1e-7a00-8000-0000000000e1"],
      rolledUpAt: ROLLED_UP_AT.toISOString(),
      // The fixture's row was rebuilt after the run sealed.
      isEstimate: false,
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
});
