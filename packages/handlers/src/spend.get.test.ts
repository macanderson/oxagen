import { spendGet } from "@oxagen/oxagen/contracts/spend.get";
import type { UnmeteredRuns } from "@oxagen/oxagen/contracts/spend.shared";
import { describe, expect, it, vi } from "vitest";
import { compareRows, createSpendGetHandler, groupRows } from "./spend.get";
import {
  daily,
  ctx,
  OPERATOR,
  pricedRun,
  run,
  SCOPE,
} from "./spend.test-support";

const OTHER = "0192d4a8-7c1e-7a00-8000-0000000000b2";
const PERIOD = { from: "2026-09-01", to: "2026-09-30" };

function harness(
  over: {
    daily?: ReturnType<typeof daily>[];
    runs?: ReturnType<typeof run>[];
    unmetered?: UnmeteredRuns;
  } = {},
) {
  const readDailyTotals = vi.fn(async () => over.daily ?? []);
  const readRunTotals = vi.fn(async () => over.runs ?? []);
  const readUnmeteredRuns = vi.fn(
    async (): Promise<UnmeteredRuns> =>
      over.unmetered ?? { total: 0, byHarness: [] },
  );
  const handler = createSpendGetHandler({
    readDailyTotals,
    readRunTotals,
    readUnmeteredRuns,
  });
  return { handler, readDailyTotals, readRunTotals, readUnmeteredRuns };
}

describe("get_spend, runs with no usage (#3304)", () => {
  it("says how many of the period's runs reported no usage, by harness, beside a total that leaves them out", async () => {
    // A Codex run with its own base URL and a Cursor run record tool calls
    // and no model usage; a Claude Code run beside them is priced. The total
    // counts all three runs and can only price one.
    const unmetered: UnmeteredRuns = {
      total: 2,
      byHarness: [
        { harness: "codex", runs: 1 },
        { harness: "cursor", runs: 1 },
      ],
    };
    const h = harness({
      runs: [
        run({ modelCalls: 0, steps: 3 }),
        run({ modelCalls: 0, steps: 2 }),
        pricedRun(4_500n),
      ],
      unmetered,
    });
    const out = await h.handler({ period: PERIOD, groupBy: "model" }, ctx());
    expect(h.readUnmeteredRuns).toHaveBeenCalledWith(SCOPE, PERIOD);
    expect(out.unmeteredRuns).toEqual(unmetered);
    expect(out.total.runs).toBe(3);
    expect(out.total.cost?.micros).toBe("4500");
    expect(() => spendGet.output.parse(out)).not.toThrow();
  });

  it("answers zero when every run reported usage", async () => {
    const h = harness({ runs: [pricedRun(4_500n)] });
    const out = await h.handler({ period: PERIOD, groupBy: "model" }, ctx());
    expect(out.unmeteredRuns).toEqual({ total: 0, byHarness: [] });
  });
});

describe("get_spend", () => {
  it("reads the level's day rows and every run row for the caller's workspace and period", async () => {
    const h = harness();
    await h.handler({ period: PERIOD, groupBy: "agent" }, ctx());
    expect(h.readDailyTotals).toHaveBeenCalledWith(SCOPE, {
      ...PERIOD,
      groupKind: "agent",
    });
    expect(h.readRunTotals).toHaveBeenCalledWith(SCOPE, PERIOD);
  });

  it("answers null money and empty rows for a period with no rollup, never a zero", async () => {
    const h = harness();
    const out = await h.handler({ period: PERIOD, groupBy: "operator" }, ctx());
    expect(out.rows).toEqual([]);
    expect(out.total).toEqual({
      cost: null,
      calls: 0,
      runs: 0,
      proven: null,
      accepted: null,
      productiveRatio: null,
    });
    expect(() => spendGet.output.parse(out)).not.toThrow();
  });

  it("sums a key's days into one row with the basis folded and the tokens added", async () => {
    const h = harness({
      daily: [
        daily({
          day: "2026-09-10",
          costMicros: 1_500n,
          costBasis: "client_attested",
          calls: 4,
          tokens: { ...daily().tokens, input_uncached: 100 },
        }),
        daily({
          day: "2026-09-11",
          costMicros: 500n,
          costBasis: "gateway_observed",
          calls: 2,
          tokens: { ...daily().tokens, input_uncached: 50 },
        }),
        daily({ day: "2026-09-12", groupKey: OTHER, runs: 3, calls: 9 }),
      ],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "operator" }, ctx());
    expect(out.rows).toHaveLength(2);
    const [priced, unpriced] = out.rows;
    expect(priced).toMatchObject({
      key: OPERATOR,
      cost: { micros: "2000", currency: "USD", basis: "mixed" },
      calls: 6,
      runs: 2,
      tokens: expect.objectContaining({ input_uncached: 150 }),
    });
    // A key no frame priced answers null, and sorts after the priced keys.
    expect(unpriced).toMatchObject({
      key: OTHER,
      cost: null,
      runs: 3,
      calls: 9,
    });
    expect(() => spendGet.output.parse(out)).not.toThrow();
  });

  it("keeps proven and accepted apart from cost and from each other", async () => {
    const h = harness({
      daily: [
        daily({
          costMicros: 900n,
          costBasis: "client_attested",
          provenMicros: 300n,
          acceptedMicros: null,
        }),
        daily({
          day: "2026-09-11",
          costMicros: 100n,
          costBasis: "client_attested",
          provenMicros: 0n,
          acceptedMicros: 100n,
        }),
      ],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "operator" }, ctx());
    expect(out.rows[0]?.proven).toEqual({ micros: "300", currency: "USD" });
    expect(out.rows[0]?.accepted).toEqual({ micros: "100", currency: "USD" });
    expect(out.rows[0]?.cost?.micros).toBe("1000");
  });

  it("totals the period over the run rows, so a run with no operator still counts", async () => {
    const h = harness({
      daily: [daily({ costMicros: 700n, costBasis: "client_attested" })],
      runs: [
        pricedRun(700n),
        pricedRun(300n, {
          operatorPrincipalId: null,
          operatorKey: null,
          verdict: "flipped",
        }),
        run({ verdict: "failing" }),
      ],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "operator" }, ctx());
    expect(out.total.runs).toBe(3);
    expect(out.total.cost).toEqual({
      micros: "1000",
      currency: "USD",
      basis: "client_attested",
    });
    // Two runs carry a verdict; only the flipped, priced one adds to proven.
    expect(out.total.proven).toEqual({ micros: "300", currency: "USD" });
    expect(out.total.accepted).toBeNull();
  });

  it("marks the total estimated when any run in it is", async () => {
    const h = harness({
      runs: [pricedRun(10n), pricedRun(5n, { costBasis: "estimated" })],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "model" }, ctx());
    expect(out.total.cost?.basis).toBe("estimated");
  });
});

describe("groupRows and compareRows", () => {
  it("orders largest spend first, unpriced keys after priced ones, ties by key", () => {
    const rows = groupRows([
      daily({ groupKey: "b", costMicros: 10n, costBasis: "client_attested" }),
      daily({ groupKey: "a", costMicros: 10n, costBasis: "client_attested" }),
      daily({ groupKey: "z" }),
      daily({ groupKey: "c", costMicros: 40n, costBasis: "client_attested" }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["c", "a", "b", "z"]);
    expect([...rows].sort(compareRows).map((r) => r.key)).toEqual(
      rows.map((r) => r.key),
    );
  });

  it("keeps a model row's provider", () => {
    const rows = groupRows([
      daily({
        groupKind: "model",
        groupKey: "claude-sonnet-5",
        provider: null,
      }),
      daily({
        groupKind: "model",
        groupKey: "claude-sonnet-5",
        day: "2026-09-11",
        provider: "anthropic",
      }),
    ]);
    expect(rows[0]?.provider).toBe("anthropic");
  });
});

describe("get_spend open runs (#3980)", () => {
  it("counts the period's runs whose cost is still a running estimate", async () => {
    const h = harness({
      runs: [
        pricedRun(1_000n),
        pricedRun(400n, { sealedAt: null }),
        run({ sealedAt: null }),
      ],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "agent" }, ctx());
    // The open run nothing priced adds no figure, so it is not one of them.
    expect(out.estimatedRuns).toBe(1);
    // The open run's cost is in the total, as the estimate it is.
    expect(out.total.cost).toEqual({
      micros: "1400",
      currency: "USD",
      basis: "client_attested",
    });
    expect(() => spendGet.output.parse(out)).not.toThrow();
  });

  it("counts none when every run has sealed", async () => {
    const h = harness({ runs: [pricedRun(10n)] });
    const out = await h.handler({ period: PERIOD, groupBy: "agent" }, ctx());
    expect(out.estimatedRuns).toBe(0);
  });
});
