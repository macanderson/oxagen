import { spendWasteList } from "@oxagen/oxagen/contracts/spend.waste";
import { type RunTotalsRecord, ZERO_TOKENS } from "@oxagen/billing";
import { describe, expect, it, vi } from "vitest";
import { cacheWriteNeverRead, createSpendWasteHandler } from "./spend.waste";
import { ctx, pricedRun, run, SCOPE } from "./spend.test-support";

const PERIOD = { from: "2026-09-01", to: "2026-09-30" };

function harness(rows: RunTotalsRecord[]) {
  const readRunTotals = vi.fn(async () => rows);
  return { handler: createSpendWasteHandler({ readRunTotals }), readRunTotals };
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
    const h = harness([small, large, pricedRun(600n), run()]);
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
      },
    ]);
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
  });
});
