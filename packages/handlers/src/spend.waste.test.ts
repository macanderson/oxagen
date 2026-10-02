import { spendWasteList } from "@oxagen/oxagen/contracts/spend.waste";
import { ZERO_TOKENS } from "@oxagen/billing";
import { describe, expect, it, vi } from "vitest";
import type { SpendRunRecord } from "./spend.shared";
import { cacheWriteNeverRead, createSpendWasteHandler } from "./spend.waste";
import { ctx, pricedRun, run, SCOPE } from "./spend.test-support";

const PERIOD = { from: "2026-09-01", to: "2026-09-30" };

function harness(
  rows: SpendRunRecord[],
  names: Record<string, string> = {},
) {
  const readRunTotals = vi.fn(async () => rows);
  const readRunNames = vi.fn(
    async (_scope: unknown, ids: readonly string[]) =>
      new Map<string, string | null>(ids.map((id) => [id, names[id] ?? null])),
  );
  return {
    handler: createSpendWasteHandler({ readRunTotals, readRunNames }),
    readRunTotals,
    readRunNames,
  };
}

/** A run that wrote `wrote` cache tokens and read `read` back. */
function cacheRun(
  micros: bigint,
  wrote: number,
  read: number,
  over: Parameters<typeof pricedRun>[1] = {},
) {
  return pricedRun(micros, {
    cacheWriteMicros: over.cacheWriteMicros ?? micros / 2n,
    tokens: { ...ZERO_TOKENS, cache_write_5m: wrote, cache_read: read },
    ...over,
  });
}

describe("cacheWriteNeverRead", () => {
  it("is the run's cache-write cost when it wrote and never read", () => {
    const waste = cacheWriteNeverRead(cacheRun(1_000n, 500, 0));
    expect(waste).toEqual({ micros: 500n, basis: "client_attested" });
  });

  it("is null when the run read its cache back, wrote none, or was never priced", () => {
    expect(cacheWriteNeverRead(cacheRun(1_000n, 500, 10))).toBeNull();
    expect(cacheWriteNeverRead(cacheRun(1_000n, 0, 0))).toBeNull();
    expect(
      cacheWriteNeverRead(
        run({ tokens: { ...ZERO_TOKENS, cache_write_5m: 500 } }),
      ),
    ).toBeNull();
  });

  it("is null for an estimated run, whose one reported figure has no class split", () => {
    expect(
      cacheWriteNeverRead(cacheRun(1_000n, 500, 0, { costBasis: "estimated" })),
    ).toBeNull();
  });

  it("is null when the book priced the cache write at nothing", () => {
    expect(
      cacheWriteNeverRead(cacheRun(1_000n, 500, 0, { cacheWriteMicros: 0n })),
    ).toBeNull();
  });
});

describe("list_waste", () => {
  it("reads every run of the caller's workspace over the period", async () => {
    const h = harness([]);
    await h.handler({ period: PERIOD }, ctx());
    expect(h.readRunTotals).toHaveBeenCalledWith(SCOPE, {
      ...PERIOD,
      filter: { kind: "all" },
    });
  });

  it("answers null waste, no causes and a null share when no run shows the pattern", async () => {
    const h = harness([pricedRun(1_000n), run()]);
    const out = await h.handler({ period: PERIOD }, ctx());
    expect(out).toEqual({
      period: PERIOD,
      wasted: null,
      share: null,
      runsWithWaste: 0,
      largestCause: null,
      causes: [],
    });
    expect(() => spendWasteList.output.parse(out)).not.toThrow();
  });

  it("sums the cause over its runs, folds the basis, cites the largest runs first, and shares over priced spend", async () => {
    const small = cacheRun(400n, 100, 0, { cacheWriteMicros: 100n });
    const large = cacheRun(1_000n, 500, 0, {
      cacheWriteMicros: 600n,
      costBasis: "gateway_observed",
    });
    const h = harness([small, large, pricedRun(600n), run()], {
      [large.runId]: "Repair the login redirect",
    });
    const out = await h.handler({ period: PERIOD }, ctx());
    expect(out.wasted).toEqual({
      micros: "700",
      currency: "USD",
      basis: "mixed",
    });
    expect(out.runsWithWaste).toBe(2);
    expect(out.largestCause).toBe("cache_write_never_read");
    // 700 wasted of 2000 priced; the unpriced run is not in the denominator.
    expect(out.share).toBeCloseTo(0.35, 10);
    expect(out.causes).toEqual([
      {
        cause: "cache_write_never_read",
        wasted: { micros: "700", currency: "USD", basis: "mixed" },
        runs: 2,
        runIds: [large.runId, small.runId],
        provingRuns: [
          { runId: large.runId, name: "Repair the login redirect" },
          { runId: small.runId, name: null },
        ],
      },
    ]);
    expect(h.readRunNames).toHaveBeenCalledWith(SCOPE, [
      large.runId,
      small.runId,
    ]);
    expect(() => spendWasteList.output.parse(out)).not.toThrow();
  });

  // ADR-235, 2026-10-02 amendment. A cause covers the runs it cites, so the
  // in-app assistant's runs are in none of it. The share's divisor is the
  // period's priced spend, so it keeps them.
  it("leaves an in-app run out of every cause and keeps its spend in the share's divisor", async () => {
    const assistant: SpendRunRecord = {
      ...cacheRun(1_000n, 500, 0, { cacheWriteMicros: 600n }),
      inApp: true,
    };
    const external = cacheRun(400n, 100, 0, { cacheWriteMicros: 100n });
    const h = harness([assistant, external]);
    const out = await h.handler({ period: PERIOD }, ctx());
    expect(out.wasted).toEqual({
      micros: "100",
      currency: "USD",
      basis: "client_attested",
    });
    expect(out.runsWithWaste).toBe(1);
    // 100 wasted of 1,400 priced: the assistant's 1,000 stays in the divisor.
    expect(out.share).toBeCloseTo(100 / 1400, 10);
    expect(out.causes[0]?.runs).toBe(1);
    expect(out.causes[0]?.runIds).toEqual([external.runId]);
    expect(h.readRunNames).toHaveBeenCalledWith(SCOPE, [external.runId]);
    expect(() => spendWasteList.output.parse(out)).not.toThrow();
  });

  it("cites at most ten runs per cause", async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      cacheRun(BigInt(100 + i), 10, 0, { cacheWriteMicros: BigInt(50 + i) }),
    );
    const h = harness(rows);
    const out = await h.handler({ period: PERIOD }, ctx());
    expect(out.causes[0]?.runs).toBe(12);
    expect(out.causes[0]?.runIds).toHaveLength(10);
    expect(out.causes[0]?.provingRuns).toHaveLength(10);
    expect(h.readRunNames.mock.calls[0]?.[1]).toHaveLength(10);
  });
});
