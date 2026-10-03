import { ZERO_TOKENS } from "@oxagen/billing";
import { ASSISTANT_SPEND_KEY } from "@oxagen/oxagen/contracts/spend.get";
import { spendDrill } from "@oxagen/oxagen/contracts/spend.drill";
import type { UnmeteredRuns } from "@oxagen/oxagen/contracts/spend.shared";
import { describe, expect, it, vi } from "vitest";
import type { ReadOperatorFacts } from "./lib/operator-facts";
import { createSpendDrillHandler, trailingWindow } from "./spend.drill";
import type { RunFilter, SpendRunRecord, SpendScope } from "./spend.shared";
import { ctx, OPERATOR, pricedRun, run, SCOPE } from "./spend.test-support";

const NOW = new Date("2026-09-14T15:00:00.000Z");

/** A fake store that filters the rows the way the Postgres predicate does. */
function harness(
  rows: SpendRunRecord[],
  unmetered: UnmeteredRuns = { total: 0, byHarness: [] },
  readOperatorFacts?: ReadOperatorFacts,
) {
  const readRunTotals = vi.fn(
    async (
      _scope: SpendScope,
      q: { from: string; to: string; filter: RunFilter },
    ) =>
      rows.filter((r) => {
        const day = r.startedAt.toISOString().slice(0, 10);
        if (day < q.from || day > q.to) return false;
        const f = q.filter;
        switch (f.kind) {
          case "all":
            return true;
          case "operator":
            return r.operatorKey === f.key;
          case "agent":
            return r.agentKey === f.key;
          case "tool":
            return r.breakdown.tools.some((t) => t.name === f.key);
        }
      }),
  );
  const readUnmeteredRuns = vi.fn(async () => unmetered);
  const handler = createSpendDrillHandler({
    readRunTotals,
    readUnmeteredRuns,
    ...(readOperatorFacts === undefined ? {} : { readOperatorFacts }),
    now: () => NOW,
  });
  return { handler, readRunTotals, readUnmeteredRuns };
}

describe("trailingWindow", () => {
  it("ends today and starts days-1 days earlier, inclusive", () => {
    expect(trailingWindow(30, NOW)).toEqual({
      from: "2026-08-16",
      to: "2026-09-14",
    });
    expect(trailingWindow(1, NOW)).toEqual({
      from: "2026-09-14",
      to: "2026-09-14",
    });
  });
});

describe("get_spend_drill", () => {
  it("reads the key's runs and every run of the workspace over the window", async () => {
    const h = harness([]);
    await h.handler({ kind: "operator", key: OPERATOR, days: 7 }, ctx());
    const period = { from: "2026-09-08", to: "2026-09-14" };
    expect(h.readRunTotals).toHaveBeenCalledWith(SCOPE, {
      ...period,
      filter: { kind: "operator", key: OPERATOR },
    });
    expect(h.readRunTotals).toHaveBeenCalledWith(SCOPE, {
      ...period,
      filter: { kind: "all" },
    });
  });

  it("answers a full series of null days, null averages and a null share when nothing was priced", async () => {
    const h = harness([]);
    const out = await h.handler(
      { kind: "agent", key: "acme.core.cc", days: 3 },
      ctx(),
    );
    expect(out.series.map((d) => d.day)).toEqual([
      "2026-09-12",
      "2026-09-13",
      "2026-09-14",
    ]);
    expect(out.series.every((d) => d.cost === null && d.runs === 0)).toBe(true);
    expect(out.averages).toEqual({ perCall: null, perRun: null });
    expect(out.share).toBeNull();
    expect(out.total.cost).toBeNull();
    // Nothing measured a token, a source or a result, so each is absent,
    // never a zero dressed as a reading (ADR-062).
    expect(out.tokens).toEqual(ZERO_TOKENS);
    expect(out.cacheHitRate).toBeNull();
    expect(out.modelCalls).toBe(0);
    expect(out.observed).toBeNull();
    expect(out.standing).toEqual({
      toolDefinitionTokens: null,
      contextFrameTokens: null,
      steeringTokens: null,
    });
    expect(out.resultTokens).toBeNull();
    expect(out.byAgent).toEqual([]);
    expect(out.byOperator).toEqual([]);
    expect(out.byModel).toEqual([]);
    expect(() => spendDrill.output.parse(out)).not.toThrow();
  });

  it("folds an operator's runs into the day series, averages rounded half to even, and the share of the workspace", async () => {
    const h = harness([
      pricedRun(1_000n, { startedAt: new Date("2026-09-13T01:00:00Z") }),
      pricedRun(250n, { startedAt: new Date("2026-09-13T02:00:00Z") }),
      pricedRun(500n, {
        startedAt: new Date("2026-09-14T02:00:00Z"),
        operatorPrincipalId: "0192d4a8-7c1e-7a00-8000-0000000000b2",
        operatorKey: "prn_zzzzzzzzzzzzzzzzzzzzzz",
      }),
      run({ startedAt: new Date("2026-09-14T03:00:00Z") }),
    ]);
    const out = await h.handler(
      { kind: "operator", key: OPERATOR, days: 2 },
      ctx(),
    );
    // The operator's unpriced run counts in runs and calls and adds no money.
    expect(out.total).toMatchObject({
      cost: { micros: "1250", currency: "USD", basis: "client_attested" },
      runs: 3,
      calls: 12,
    });
    expect(out.series).toEqual([
      {
        day: "2026-09-13",
        cost: { micros: "1250", currency: "USD", basis: "client_attested" },
        calls: 8,
        runs: 2,
      },
      { day: "2026-09-14", cost: null, calls: 4, runs: 1 },
    ]);
    // 1250 ÷ 12 = 104.17 → 104; 1250 ÷ 3 = 416.67 → 417.
    expect(out.averages).toEqual({
      perCall: { micros: "104", currency: "USD" },
      perRun: { micros: "417", currency: "USD" },
    });
    // 1250 of the workspace's 1750 priced micros; the unpriced run adds nothing.
    expect(out.share).toBeCloseTo(1250 / 1750, 10);
    expect(out.byTool).toEqual([
      { name: "Read", calls: 4, runs: 2, resultTokens: null, cost: null },
    ]);
    expect(() => spendDrill.output.parse(out)).not.toThrow();
  });

  it("prices a tool's results as input its runs already paid, with the estimated basis and no share", async () => {
    // A gateway-metered run, so the null `observed` below comes from the
    // tool drill's rule and not from a run nobody metered.
    const h = harness([
      pricedRun(9_000n, {
        startedAt: new Date("2026-09-14T02:00:00Z"),
        costBasis: "gateway_observed",
        verdict: "flipped",
        accepted: true,
        breakdown: {
          models: pricedRun(9_000n, { costBasis: "gateway_observed" })
            .breakdown.models,
          tools: [
            { name: "Read", calls: 3, resultTokens: null, costMicros: null },
            { name: "Bash", calls: 5, resultTokens: 800, costMicros: 2_400n },
          ],
          steps: null,
        },
      }),
      pricedRun(100n, { startedAt: new Date("2026-09-14T03:00:00Z") }),
    ]);
    const out = await h.handler({ kind: "tool", key: "Bash", days: 1 }, ctx());
    // The tool's own calls and its results' estimate, never the run's cost,
    // and never proven or accepted: the estimate is part of the run's input.
    expect(out.total).toEqual({
      cost: { micros: "2400", currency: "USD", basis: "estimated" },
      calls: 5,
      runs: 1,
      proven: null,
      accepted: null,
      productiveRatio: null,
    });
    expect(out.series).toEqual([
      {
        day: "2026-09-14",
        cost: { micros: "2400", currency: "USD", basis: "estimated" },
        calls: 5,
        runs: 1,
      },
    ]);
    // 2400 ÷ 5 calls; 2400 ÷ 1 run.
    expect(out.averages).toEqual({
      perCall: { micros: "480", currency: "USD" },
      perRun: { micros: "2400", currency: "USD" },
    });
    // The estimate is a part of the run's cost, so it is no share of the
    // workspace's spend, and no part of it is the gateway's to have observed.
    expect(out.share).toBeNull();
    expect(out.observed).toBeNull();
    expect(out.resultTokens).toBe(800);
    expect(out.byTool).toEqual([
      {
        name: "Bash",
        calls: 5,
        runs: 1,
        resultTokens: 800,
        cost: { micros: "2400", currency: "USD", basis: "estimated" },
      },
      { name: "Read", calls: 3, runs: 1, resultTokens: null, cost: null },
    ]);
    // By agent and by operator split the tool's figure; a tool has no model rows.
    expect(out.byAgent).toEqual([
      {
        key: "acme.core.cc",
        provider: null,
        operator: null,
        runs: 1,
        calls: 5,
        cost: { micros: "2400", currency: "USD", basis: "estimated" },
        tokens: { ...ZERO_TOKENS, input_uncached: 1000, output: 200 },
        resultTokens: 800,
      },
    ]);
    expect(out.byOperator.map((row) => [row.key, row.calls, row.cost])).toEqual(
      [[OPERATOR, 5, { micros: "2400", currency: "USD", basis: "estimated" }]],
    );
    expect(out.byModel).toEqual([]);
    expect(() => spendDrill.output.parse(out)).not.toThrow();
  });

  it("keeps a tool's money and result tokens null when no call recorded a result (negative)", async () => {
    const h = harness([
      pricedRun(9_000n, {
        startedAt: new Date("2026-09-14T02:00:00Z"),
        breakdown: {
          models: pricedRun(9_000n).breakdown.models,
          tools: [
            { name: "Bash", calls: 4, resultTokens: null, costMicros: null },
          ],
          steps: null,
        },
      }),
    ]);
    const out = await h.handler({ kind: "tool", key: "Bash", days: 1 }, ctx());
    // The run is priced, and still nothing priced the tool's results: the
    // run's own cost never stands in for the tool's.
    expect(out.total.cost).toBeNull();
    expect(out.total.calls).toBe(4);
    expect(out.averages).toEqual({ perCall: null, perRun: null });
    expect(out.series[0]?.cost).toBeNull();
    expect(out.resultTokens).toBeNull();
    expect(out.byAgent[0]).toMatchObject({ cost: null, resultTokens: null });
    expect(() => spendDrill.output.parse(out)).not.toThrow();
  });

  it("sums an operator's tokens, takes the cache hit rate from them, and splits the spend by agent, operator and model", async () => {
    const facts = vi.fn<ReadOperatorFacts>(async () => {
      return new Map([
        [
          OPERATOR,
          {
            id: OPERATOR,
            name: "Marcus Bell",
            email: null,
            avatarUrl: null,
            role: null,
          },
        ],
      ]);
    });
    const metered: SpendRunRecord = {
      ...pricedRun(1_000n, {
        startedAt: new Date("2026-09-13T01:00:00Z"),
        costBasis: "gateway_observed",
        tokens: { ...ZERO_TOKENS, input_uncached: 1000, cache_read: 3000 },
        // The run row's own rate is spend-weighted; the drill never reads it.
        cacheHitRate: 0.99,
      }),
      toolDefinitionTokens: 400,
      steeringTokens: null,
    };
    metered.breakdown = {
      ...metered.breakdown,
      tools: [{ name: "Bash", calls: 2, resultTokens: 300, costMicros: 30n }],
    };
    const reported: SpendRunRecord = {
      ...pricedRun(500n, {
        startedAt: new Date("2026-09-13T02:00:00Z"),
        costBasis: "client_attested",
        agentKey: "acme.core.review",
      }),
      toolDefinitionTokens: 100,
      contextFrameTokens: 50,
    };
    // No agent and no price: it counts for the operator and in no agent row.
    const loose = run({
      startedAt: new Date("2026-09-14T01:00:00Z"),
      agentKey: null,
    });
    const h = harness([metered, reported, loose], undefined, facts);
    const out = await h.handler(
      { kind: "operator", key: OPERATOR, days: 2 },
      ctx(),
    );
    // `pricedRun` takes a run's tokens whole when a test gives them, so the
    // metered run carries no output and the reported run carries 200.
    expect(out.tokens).toEqual({
      ...ZERO_TOKENS,
      input_uncached: 2000,
      cache_read: 3000,
      output: 200,
    });
    // 3000 read ÷ (2000 uncached + 3000 read), token-weighted; not the 0.99
    // a run row stored.
    expect(out.cacheHitRate).toBeCloseTo(0.6, 10);
    // `total.calls` counts steps (12); the model calls are 2 per run.
    expect(out.total.calls).toBe(12);
    expect(out.modelCalls).toBe(6);
    // The gateway metered the one gateway_observed model.
    expect(out.observed).toEqual({ micros: "1000", currency: "USD" });
    // A source one run measured sums; a source no run measured stays null.
    expect(out.standing).toEqual({
      toolDefinitionTokens: 500,
      contextFrameTokens: 50,
      steeringTokens: null,
    });
    expect(out.resultTokens).toBe(300);
    expect(out.byAgent).toEqual([
      {
        key: "acme.core.cc",
        provider: null,
        operator: null,
        runs: 1,
        calls: 4,
        cost: { micros: "1000", currency: "USD", basis: "gateway_observed" },
        tokens: { ...ZERO_TOKENS, input_uncached: 1000, cache_read: 3000 },
        resultTokens: null,
      },
      {
        key: "acme.core.review",
        provider: null,
        operator: null,
        runs: 1,
        calls: 4,
        cost: { micros: "500", currency: "USD", basis: "client_attested" },
        tokens: { ...ZERO_TOKENS, input_uncached: 1000, output: 200 },
        resultTokens: null,
      },
    ]);
    expect(facts).toHaveBeenCalledWith(SCOPE, [OPERATOR]);
    expect(out.byOperator).toEqual([
      {
        key: OPERATOR,
        provider: null,
        operator: {
          id: OPERATOR,
          name: "Marcus Bell",
          email: null,
          avatarUrl: null,
          role: null,
        },
        runs: 3,
        calls: 12,
        cost: { micros: "1500", currency: "USD", basis: "mixed" },
        tokens: out.tokens,
        resultTokens: null,
      },
    ]);
    // One model across two runs: its calls, its tokens, and the bases folded.
    expect(out.byModel).toEqual([
      {
        key: "claude-sonnet-5",
        provider: "anthropic",
        operator: null,
        runs: 2,
        calls: 4,
        cost: { micros: "1500", currency: "USD", basis: "mixed" },
        tokens: { ...ZERO_TOKENS, input_uncached: 2000, output: 400 },
        resultTokens: null,
      },
    ]);
    expect(() => spendDrill.output.parse(out)).not.toThrow();
  });

  it("caps the share at one when the key's rows out-sum the workspace read", async () => {
    // A key's runs and the workspace's runs are two reads; a row that lands
    // between them cannot push the share above the whole.
    const readRunTotals = vi
      .fn()
      .mockResolvedValueOnce([pricedRun(300n, { startedAt: NOW })])
      .mockResolvedValueOnce([pricedRun(200n, { startedAt: NOW })]);
    const handler = createSpendDrillHandler({
      readRunTotals,
      readUnmeteredRuns: async () => ({ total: 0, byHarness: [] }),
      now: () => NOW,
    });
    const out = await handler(
      { kind: "operator", key: OPERATOR, days: 1 },
      ctx(),
    );
    expect(out.share).toBe(1);
  });
});

// ADR-235, 2026-10-02 amendment: the Spend page keeps the in-app assistant's
// spend in a row of its own, so a drill on a customer key leaves it out, and
// the share's divisor, the workspace's whole spend, keeps it.
describe("get_spend_drill and the in-app assistant", () => {
  it("leaves the assistant's runs out of an operator's drill, and keeps them in the share's divisor", async () => {
    const h = harness([
      pricedRun(400n, { startedAt: new Date("2026-09-13T01:00:00Z") }),
      {
        ...pricedRun(900n, { startedAt: new Date("2026-09-13T02:00:00Z") }),
        inApp: true,
      },
    ]);
    const out = await h.handler(
      { kind: "operator", key: OPERATOR, days: 2 },
      ctx(),
    );
    expect(out.total).toMatchObject({ cost: { micros: "400" }, runs: 1 });
    expect(out.share).toBeCloseTo(400 / 1300, 10);
    expect(() => spendDrill.output.parse(out)).not.toThrow();
  });

  it("answers an empty drill for the assistant row's key", async () => {
    const h = harness([
      {
        ...pricedRun(900n, { startedAt: new Date("2026-09-13T02:00:00Z") }),
        inApp: true,
      },
    ]);
    const out = await h.handler(
      { kind: "agent", key: ASSISTANT_SPEND_KEY, days: 2 },
      ctx(),
    );
    expect(out.total).toMatchObject({ cost: null, runs: 0 });
    expect(() => spendDrill.output.parse(out)).not.toThrow();
  });
});

describe("get_spend_drill, runs with no usage (#3304)", () => {
  const unmetered: UnmeteredRuns = {
    total: 1,
    byHarness: [{ harness: "codex", runs: 1 }],
  };

  it("counts the key's own runs that reported no usage, with the drill's filter", async () => {
    const h = harness([pricedRun(300n, { startedAt: NOW })], unmetered);
    const out = await h.handler(
      { kind: "agent", key: "acme.core.cc", days: 7 },
      ctx(),
    );
    expect(h.readUnmeteredRuns).toHaveBeenCalledWith(SCOPE, {
      from: "2026-09-08",
      to: "2026-09-14",
      filter: { kind: "agent", key: "acme.core.cc" },
    });
    expect(out.unmeteredRuns).toEqual(unmetered);
    expect(() => spendDrill.output.parse(out)).not.toThrow();
  });

  it("leaves a tool drill without the count, since it carries no money (negative)", async () => {
    const h = harness([pricedRun(300n, { startedAt: NOW })], unmetered);
    const out = await h.handler({ kind: "tool", key: "Read", days: 7 }, ctx());
    expect(h.readUnmeteredRuns).not.toHaveBeenCalled();
    expect(out.unmeteredRuns).toBeUndefined();
  });
});
