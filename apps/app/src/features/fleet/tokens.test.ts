// Fleet's token figures (#3834): each row's total and cached share, and the
// Tokens shown tile. The tile is recomputed here from the rows, so a tile
// that disagreed with its cells would fail.
import { describe, expect, it } from "vitest";
import { runRow } from "./fleet.builders";
import { shownTokens, tokensShown } from "./tokens";

const usd = (micros: string) => ({
  micros,
  currency: "USD",
  basis: "gateway_observed" as const,
});

const counts = (over: Partial<ReturnType<typeof base>> = {}) => ({
  ...base(),
  ...over,
});
function base() {
  return {
    inputUncached: 1_000,
    cacheRead: 3_000,
    cacheWrite5m: 500,
    cacheWrite1h: 0,
    output: 400,
    reasoning: 100,
  };
}

describe("shownTokens", () => {
  it("totals every class and reads cache reads over input", () => {
    expect(shownTokens(runRow({ tokens: counts() }))).toEqual({
      total: 5_000,
      cached: 0.75,
      reported: false,
    });
  });

  it("falls back to the agent's count while no rollup row exists, and says so", () => {
    expect(
      shownTokens(
        runRow({
          tokens: null,
          reportedTokens: {
            input: 100,
            output: 50,
            cacheRead: 300,
            cacheWrite: 50,
          },
        }),
      ),
    ).toEqual({ total: 500, cached: 0.75, reported: true });
  });

  it("prefers the rollup's count over the agent's", () => {
    expect(
      shownTokens(
        runRow({
          tokens: counts(),
          reportedTokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        }),
      )?.reported,
    ).toBe(false);
  });

  it("reads no cached share for a run that read no input (negative)", () => {
    expect(
      shownTokens(
        runRow({ tokens: counts({ inputUncached: 0, cacheRead: 0 }) }),
      )?.cached,
    ).toBeNull();
  });

  it("reads null with neither figure, never zero (negative)", () => {
    expect(
      shownTokens(runRow({ tokens: null, reportedTokens: null })),
    ).toBeNull();
    // A server that predates the field.
    expect(shownTokens(runRow({ reportedTokens: null }))).toBeNull();
  });
});

describe("tokensShown", () => {
  it("sums the rows listed, and counts the ones it left out and the reported ones", () => {
    const rows = [
      runRow({ id: "arun_a", tokens: counts() }),
      runRow({
        id: "tse_b",
        tokens: null,
        reportedTokens: {
          input: 100,
          output: 50,
          cacheRead: 300,
          cacheWrite: 50,
        },
      }),
      runRow({ id: "tse_c", tokens: null, reportedTokens: null }),
    ].map((run) => ({ run }));
    const shown = tokensShown(rows);
    // The tile is the sum of the cells.
    const cells = rows.map(({ run }) => shownTokens(run)?.total ?? 0);
    expect(shown.total).toBe(cells.reduce((a, b) => a + b, 0));
    expect(shown).toMatchObject({ total: 5_500, unrecorded: 1, reported: 1 });
  });

  it("weights each row's cache rate by its cost", () => {
    // $3 at 90% and $1 at 10%: (2.7 + 0.1) / 4 = 70%, where an unweighted
    // mean of the rates would say 50%.
    const shown = tokensShown(
      [
        runRow({
          id: "arun_big",
          tokens: counts(),
          cost: usd("3000000"),
          cacheHitRate: 0.9,
        }),
        runRow({
          id: "arun_small",
          tokens: counts(),
          cost: usd("1000000"),
          cacheHitRate: 0.1,
        }),
      ].map((run) => ({ run })),
    );
    expect(shown.servedFromCache).toBeCloseTo(0.7, 6);
  });

  it("leaves out a row with a rate and no cost, or a cost and no rate", () => {
    const shown = tokensShown(
      [
        runRow({ id: "arun_a", cost: usd("1000000"), cacheHitRate: 0.5 }),
        runRow({ id: "arun_b", cost: null, cacheHitRate: 0.9 }),
        runRow({ id: "arun_c", cost: usd("5000000"), cacheHitRate: null }),
      ].map((run) => ({ run })),
    );
    expect(shown.servedFromCache).toBe(0.5);
  });

  it("reads no cache figure when no row carries one (negative)", () => {
    expect(
      tokensShown([{ run: runRow({ tokens: counts(), cacheHitRate: null }) }])
        .servedFromCache,
    ).toBeNull();
  });

  it("reads no cache figure across two currencies (negative)", () => {
    const shown = tokensShown(
      [
        runRow({ id: "arun_a", cost: usd("1000000"), cacheHitRate: 0.5 }),
        runRow({
          id: "arun_b",
          cost: { ...usd("1000000"), currency: "EUR" },
          cacheHitRate: 0.5,
        }),
      ].map((run) => ({ run })),
    );
    expect(shown.servedFromCache).toBeNull();
  });

  it("reads null over rows with no figure, never zero (negative)", () => {
    expect(
      tokensShown([{ run: runRow({ tokens: null, reportedTokens: null }) }]),
    ).toEqual({
      total: null,
      unrecorded: 1,
      reported: 0,
      servedFromCache: null,
    });
    expect(tokensShown([]).total).toBeNull();
  });
});
