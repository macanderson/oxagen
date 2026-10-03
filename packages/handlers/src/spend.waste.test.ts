import {
  spendWasteList,
  WASTE_CLAIM_CAUSES,
} from "@oxagen/oxagen/contracts/spend.waste";
import {
  UNPRODUCTIVE_ESTIMATE,
  UNPRODUCTIVE_PARTS,
} from "@oxagen/oxagen/contracts/spend.unproductive";
import { ZERO_TOKENS } from "@oxagen/billing";
import {
  FINDING_CLAIM_DETECTORS,
  FINDING_KINDS,
} from "@oxagen/database/schema";
import { describe, expect, it, vi } from "vitest";
import type { CauseClaim } from "./lib/finding-claims";
import type { SpendRunRecord } from "./spend.shared";
import {
  cacheWriteNeverRead,
  claimedHits,
  createSpendWasteHandler,
} from "./spend.waste";
import { createUnproductiveSpendHandler } from "./spend.unproductive";
import { ctx, pricedRun, run, SCOPE } from "./spend.test-support";

const PERIOD = { from: "2026-09-01", to: "2026-09-30" };
/** The whole of the period's last day is in the window. */
const WINDOW = {
  start: new Date("2026-09-01T00:00:00.000Z"),
  end: new Date("2026-10-01T00:00:00.000Z"),
};

function harness(
  rows: SpendRunRecord[],
  names: Record<string, string> = {},
  over: { claims?: CauseClaim[]; outside?: number } = {},
) {
  const readRunTotals = vi.fn(async () => rows);
  const readClaims = vi.fn(async () => over.claims ?? []);
  const countFindingsOutside = vi.fn(async () => over.outside ?? 0);
  const readRunNames = vi.fn(
    async (_scope: unknown, ids: readonly string[]) =>
      new Map<string, string | null>(ids.map((id) => [id, names[id] ?? null])),
  );
  return {
    handler: createSpendWasteHandler({
      readRunTotals,
      readClaims,
      countFindingsOutside,
      readRunNames,
    }),
    readRunTotals,
    readClaims,
    countFindingsOutside,
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

function runId(n: number): string {
  return `tse_${String(n).padStart(22, "9")}`;
}

/** One claimed call of run `n`, under a finding of `kind`. */
function claim(
  n: number,
  frame: string,
  kind: string,
  micros: bigint,
  over: Partial<CauseClaim> = {},
): CauseClaim {
  const detector =
    kind === "recurring_runs" ? 7 : kind === "spend_with_no_outcome" ? 8 : 1;
  return {
    detector,
    kind,
    runId: runId(n),
    frameKey: frame,
    costMicros: micros,
    currency: "USD",
    basis: "client_attested",
    ...over,
  };
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
  it("reads every run of the caller's workspace over the period, and the claims and outside findings over its whole last day", async () => {
    const h = harness([]);
    await h.handler({ period: PERIOD }, ctx());
    expect(h.readRunTotals).toHaveBeenCalledWith(SCOPE, {
      ...PERIOD,
      filter: { kind: "all" },
    });
    expect(h.readClaims).toHaveBeenCalledWith(SCOPE, WINDOW);
    expect(h.countFindingsOutside).toHaveBeenCalledWith(SCOPE, WINDOW);
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
      findingsOutsidePeriod: 0,
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

// #5294: the calls findings claim are causes, so Wasted spend shows what the
// Findings tab shows for the same period.
describe("list_waste claimed causes", () => {
  const claims = [
    // Run 1: a spin loop and a repeat claim one call; it counts once, as a
    // spin loop, the earlier cause of detector 1.
    claim(1, "f1", "duplicate_tool_calls", 700n),
    claim(1, "f1", "spin_loops", 700n),
    // Run 1's second call, a repeated shell command.
    claim(1, "f2", "repeated_shell_commands", 300n),
    // Run 2: detector 7 and detector 8 claim one call; 7 counts it.
    claim(2, "f1", "spend_with_no_outcome", 900n),
    claim(2, "f1", "recurring_runs", 900n),
    // Run 3: a retry loop.
    claim(3, "f1", "retry_loops", 250n, { basis: "gateway_observed" }),
    // Run 4: spend with no outcome.
    claim(4, "f1", "spend_with_no_outcome", 100n),
  ];

  it("counts each claimed call once, under the lowest detector and then the earliest cause", () => {
    const hits = claimedHits(claims)
      .map((h) => `${h.cause} ${h.runId} ${String(h.micros)}`)
      .sort();
    expect(hits).toEqual(
      [
        `spin_loops ${runId(1)} 700`,
        `repeated_calls ${runId(1)} 300`,
        `recurring_runs ${runId(2)} 900`,
        `retry_loops ${runId(3)} 250`,
        `spend_with_no_outcome ${runId(4)} 100`,
      ].sort(),
    );
  });

  it("draws every claimed cause, largest first, with the runs that prove each", async () => {
    const h = harness([], { [runId(2)]: "Nightly dependency check" }, {
      claims,
      outside: 2,
    });
    const out = await h.handler({ period: PERIOD }, ctx());
    expect(out.causes.map((c) => [c.cause, c.wasted.micros])).toEqual([
      ["recurring_runs", "900"],
      ["spin_loops", "700"],
      ["repeated_calls", "300"],
      ["retry_loops", "250"],
      ["spend_with_no_outcome", "100"],
    ]);
    expect(out.largestCause).toBe("recurring_runs");
    expect(out.wasted).toEqual({
      micros: "2250",
      currency: "USD",
      basis: "mixed",
    });
    expect(out.runsWithWaste).toBe(4);
    expect(out.causes[0]?.provingRuns).toEqual([
      { runId: runId(2), name: "Nightly dependency check" },
    ]);
    // Each cause carries the basis of the findings behind it.
    expect(out.causes.find((c) => c.cause === "retry_loops")?.wasted.basis).toBe(
      "gateway_observed",
    );
    expect(out.causes.find((c) => c.cause === "spin_loops")?.wasted.basis).toBe(
      "client_attested",
    );
    // A run cited by two causes is read for its name once.
    expect(h.readRunNames).toHaveBeenCalledTimes(1);
    expect(h.readRunNames.mock.calls[0]?.[1]).toEqual([
      runId(2),
      runId(1),
      runId(3),
      runId(4),
    ]);
    expect(out.findingsOutsidePeriod).toBe(2);
    // No run started in the period, so nothing is priced to share against.
    expect(out.share).toBeNull();
    expect(() => spendWasteList.output.parse(out)).not.toThrow();
  });

  it("totals the unproductive spend headline for the same claims and period, plus the cache-write cause", async () => {
    const cache = cacheRun(5_000n, 100, 0, { cacheWriteMicros: 400n });
    const out = await harness([cache], {}, { claims }).handler(
      { period: PERIOD },
      ctx(),
    );
    const headline = await createUnproductiveSpendHandler({
      readClaims: async () =>
        claims.map((c) => ({
          detector: c.detector,
          runId: c.runId,
          frameKey: c.frameKey,
          operatorKey: null,
          costMicros: c.costMicros,
          currency: c.currency,
        })),
      readSpend: async () => ({ rows: [], partial: new Set() }),
      readKindSavings: async () => [],
      countFindingsOutside: async () => 0,
    })({ period: PERIOD }, ctx());
    const cacheCause = out.causes.find(
      (c) => c.cause === "cache_write_never_read",
    );
    expect(cacheCause?.wasted.micros).toBe("400");
    expect(BigInt(out.wasted?.micros ?? "0")).toBe(
      BigInt(headline.unproductive.micros) + 400n,
    );
    // 2,650 wasted of the 5,000 the period's one run was priced at.
    expect(out.share).toBeCloseTo(2650 / 5000, 10);
  });

  it("leaves a run whose calls a finding claims out of the cache-write cause", async () => {
    const claimed = cacheRun(5_000n, 100, 0, {
      runId: runId(1),
      cacheWriteMicros: 400n,
    });
    const out = await harness([claimed], {}, {
      claims: [claim(1, "f1", "recurring_runs", 1_000n)],
    }).handler({ period: PERIOD }, ctx());
    expect(out.causes.map((c) => c.cause)).toEqual(["recurring_runs"]);
    expect(out.wasted?.micros).toBe("1000");
    expect(out.runsWithWaste).toBe(1);
  });

  it("answers no waste in a period no finding claims a call of, and says how many open findings fall outside it", async () => {
    const out = await harness([pricedRun(1_000n)], {}, { outside: 4 }).handler(
      { period: PERIOD },
      ctx(),
    );
    expect(out.wasted).toBeNull();
    expect(out.causes).toEqual([]);
    expect(out.findingsOutsidePeriod).toBe(4);
    expect(() => spendWasteList.output.parse(out)).not.toThrow();
  });

  it("refuses a period whose causes hold two currencies (negative)", async () => {
    const refusal = harness([cacheRun(1_000n, 10, 0)], {}, {
      claims: [claim(1, "f1", "spin_loops", 700n, { currency: "EUR" })],
    }).handler({ period: PERIOD }, ctx());
    await expect(refusal).rejects.toMatchObject({
      code: "conflict",
      reason: "waste_mixed_currency",
    });
    await expect(refusal).rejects.toThrow(/EUR and in USD/);
  });

  it("names a cause for every kind a counting detector writes, and none for a kind the headline leaves out", () => {
    const claiming = WASTE_CLAIM_CAUSES.flatMap((c) => [...c.kinds]);
    const beside: readonly string[] = [
      ...UNPRODUCTIVE_PARTS.flatMap((p) => p.kinds),
      ...UNPRODUCTIVE_ESTIMATE.kinds,
      // Proposes steering records and prices no call.
      "repeated_instructions",
    ];
    expect([...claiming, ...beside].sort()).toEqual([...FINDING_KINDS].sort());
    const detectors: readonly number[] = FINDING_CLAIM_DETECTORS;
    for (const c of WASTE_CLAIM_CAUSES)
      expect(detectors).toContain(c.detector);
  });
});
