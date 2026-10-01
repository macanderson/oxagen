import { type ModelCallFrame, ZERO_TOKENS } from "@oxagen/billing";
import { describe, expect, it, vi } from "vitest";
import {
  CROSSING_RUNS_PRICED_MAX,
  type FrameTimeSpendDeps,
  insideWindow,
  type OverlappingRun,
  priceFramesIn,
  readFrameTimeSpend,
} from "./frame-time-spend";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const SEPTEMBER = {
  start: new Date("2026-09-01T00:00:00.000Z"),
  end: new Date("2026-10-01T00:00:00.000Z"),
};
const ANA = "prn_0000000000000000000ana";
const BEN = "prn_0000000000000000000ben";

function runId(n: number): string {
  return `tse_${String(n).padStart(22, "0")}`;
}

function run(
  n: number,
  over: Partial<OverlappingRun> & { startedAt: string; lastFrameBound: string },
): OverlappingRun {
  return {
    runId: runId(n),
    operatorKey: ANA,
    currency: "USD",
    costMicros: 1_000n,
    ...over,
    startedAt: new Date(over.startedAt),
    lastFrameBound: new Date(over.lastFrameBound),
  };
}

function deps(
  runs: OverlappingRun[],
  priced: (id: string) => Promise<bigint | null> = async () => 0n,
) {
  return {
    readRuns: vi.fn(async () => runs),
    priceRunFrames: vi.fn(async (_scope: unknown, id: string) => priced(id)),
    reportPriceFailure: vi.fn(),
  } satisfies FrameTimeSpendDeps;
}

describe("insideWindow", () => {
  it("holds a run whose start and last frame bound fall in the window", () => {
    expect(
      insideWindow(
        run(1, {
          startedAt: "2026-09-01T00:00:00Z",
          lastFrameBound: "2026-09-30T23:59:59Z",
        }),
        SEPTEMBER,
      ),
    ).toBe(true);
  });

  it.each([
    ["started before the window", "2026-08-31T23:59:59Z", "2026-09-01T01:00:00Z"],
    ["ran up to the window's end", "2026-09-30T23:00:00Z", "2026-10-01T00:00:00Z"],
  ])("leaves out a run that %s", (_label, startedAt, lastFrameBound) => {
    expect(insideWindow(run(1, { startedAt, lastFrameBound }), SEPTEMBER)).toBe(
      false,
    );
  });
});

describe("readFrameTimeSpend", () => {
  it("adds a run inside the window whole and prices a crossing run by its frames", async () => {
    const d = deps(
      [
        run(1, {
          costMicros: 3_000n,
          startedAt: "2026-09-10T00:00:00Z",
          lastFrameBound: "2026-09-10T01:00:00Z",
        }),
        run(2, {
          costMicros: 9_000n,
          startedAt: "2026-08-31T23:00:00Z",
          lastFrameBound: "2026-09-01T01:00:00Z",
        }),
        run(3, {
          operatorKey: null,
          costMicros: 500n,
          startedAt: "2026-09-12T00:00:00Z",
          lastFrameBound: "2026-09-12T00:10:00Z",
        }),
      ],
      async () => 1_000n,
    );
    const out = await readFrameTimeSpend(d, SCOPE, SEPTEMBER, null);
    expect(out.partial.size).toBe(0);
    expect(out.rows).toEqual(
      expect.arrayContaining([
        { operatorKey: ANA, currency: "USD", micros: 4_000n },
        { operatorKey: null, currency: "USD", micros: 500n },
      ]),
    );
    expect(out.rows).toHaveLength(2);
    expect(d.priceRunFrames).toHaveBeenCalledTimes(1);
    expect(d.priceRunFrames).toHaveBeenCalledWith(SCOPE, runId(2), SEPTEMBER);
    expect(d.readRuns).toHaveBeenCalledWith(SCOPE, SEPTEMBER, null);
  });

  it("keeps each currency apart", async () => {
    const d = deps([
      run(1, {
        startedAt: "2026-09-10T00:00:00Z",
        lastFrameBound: "2026-09-10T01:00:00Z",
      }),
      run(2, {
        currency: "EUR",
        costMicros: 700n,
        startedAt: "2026-09-11T00:00:00Z",
        lastFrameBound: "2026-09-11T01:00:00Z",
      }),
    ]);
    const out = await readFrameTimeSpend(d, SCOPE, SEPTEMBER, [ANA]);
    expect(out.rows).toEqual(
      expect.arrayContaining([
        { operatorKey: ANA, currency: "USD", micros: 1_000n },
        { operatorKey: ANA, currency: "EUR", micros: 700n },
      ]),
    );
  });

  it("marks an operator partial when its crossing run cannot be priced", async () => {
    const d = deps(
      [
        run(1, {
          startedAt: "2026-08-30T00:00:00Z",
          lastFrameBound: "2026-09-02T00:00:00Z",
        }),
        run(2, {
          operatorKey: BEN,
          startedAt: "2026-08-30T00:00:00Z",
          lastFrameBound: "2026-09-02T00:00:00Z",
        }),
      ],
      async (id) => (id === runId(1) ? null : 200n),
    );
    const out = await readFrameTimeSpend(d, SCOPE, SEPTEMBER, [ANA, BEN]);
    expect([...out.partial]).toEqual([ANA]);
    expect(out.rows).toEqual([
      { operatorKey: BEN, currency: "USD", micros: 200n },
    ]);
  });

  it("reports a price read that throws and marks its operator partial", async () => {
    const failure = new Error("clickhouse unavailable");
    const d = deps(
      [
        run(1, {
          startedAt: "2026-08-30T00:00:00Z",
          lastFrameBound: "2026-09-02T00:00:00Z",
        }),
      ],
      async () => {
        throw failure;
      },
    );
    const out = await readFrameTimeSpend(d, SCOPE, SEPTEMBER, [ANA]);
    expect([...out.partial]).toEqual([ANA]);
    expect(d.reportPriceFailure).toHaveBeenCalledWith(SCOPE, runId(1), failure);
  });

  it("prices the largest crossing runs up to the cap and marks the rest partial", async () => {
    const crossing = Array.from(
      { length: CROSSING_RUNS_PRICED_MAX + 1 },
      (_, i) =>
        run(i + 1, {
          operatorKey: i === 0 ? BEN : ANA,
          costMicros: BigInt(i + 1),
          startedAt: "2026-08-30T00:00:00Z",
          lastFrameBound: "2026-09-02T00:00:00Z",
        }),
    );
    const d = deps(crossing, async () => 1n);
    const out = await readFrameTimeSpend(d, SCOPE, SEPTEMBER, null);
    expect(d.priceRunFrames).toHaveBeenCalledTimes(CROSSING_RUNS_PRICED_MAX);
    // Run 1 is Ben's and the smallest, so it is the one left unread.
    expect(d.priceRunFrames).not.toHaveBeenCalledWith(
      SCOPE,
      runId(1),
      SEPTEMBER,
    );
    expect([...out.partial]).toEqual([BEN]);
  });

  it("reads nothing for an empty operator list", async () => {
    const d = deps([]);
    expect(await readFrameTimeSpend(d, SCOPE, SEPTEMBER, [])).toEqual({
      rows: [],
      partial: new Set(),
    });
    expect(d.readRuns).not.toHaveBeenCalled();
  });
});

describe("priceFramesIn", () => {
  function frame(at: string, reportedCostMicros: bigint): ModelCallFrame {
    return {
      at: new Date(at),
      model: "model-with-no-price",
      provider: null,
      tokens: { ...ZERO_TOKENS, output: 10 },
      reportedCostMicros,
      basis: "client_attested",
    };
  }

  it("prices only the frames that ran in the window", () => {
    const frames = [
      frame("2026-08-31T23:59:59Z", 100n),
      frame("2026-09-01T00:00:00Z", 200n),
      frame("2026-09-30T23:59:59Z", 300n),
      frame("2026-10-01T00:00:00Z", 400n),
    ];
    // An empty book prices nothing, so each frame falls back to the cost its
    // own record reports, as the rollup's rule does.
    expect(priceFramesIn(SCOPE.orgId, frames, SEPTEMBER, [])).toBe(500n);
  });
});
