import { spendDrill } from "@oxagen/oxagen/contracts/spend.drill";
import type { UnmeteredRuns } from "@oxagen/oxagen/contracts/spend.shared";
import type { RunTotalsRecord } from "@oxagen/billing";
import { describe, expect, it, vi } from "vitest";
import { createSpendDrillHandler, trailingWindow } from "./spend.drill";
import type { RunFilter, SpendScope } from "./spend.shared";
import { ctx, OPERATOR, pricedRun, run, SCOPE } from "./spend.test-support";

const NOW = new Date("2026-09-14T15:00:00.000Z");

/** A fake store that filters the rows the way the Postgres predicate does. */
function harness(
  rows: RunTotalsRecord[],
  unmetered: UnmeteredRuns = { total: 0, byHarness: [] },
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
    expect(out.byTool).toEqual([{ name: "Read", calls: 4, runs: 2 }]);
    expect(() => spendDrill.output.parse(out)).not.toThrow();
  });

  it("carries counts and no money for a tool, counting that tool's own calls", async () => {
    const h = harness([
      pricedRun(900n, {
        startedAt: new Date("2026-09-14T02:00:00Z"),
        verdict: "flipped",
        breakdown: {
          models: pricedRun(900n).breakdown.models,
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
    expect(out.total).toEqual({
      cost: null,
      calls: 5,
      runs: 1,
      proven: null,
      accepted: null,
      productiveRatio: null,
    });
    expect(out.averages).toEqual({ perCall: null, perRun: null });
    expect(out.share).toBeNull();
    expect(out.byTool).toEqual([
      { name: "Bash", calls: 5, runs: 1 },
      { name: "Read", calls: 3, runs: 1 },
    ]);
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
