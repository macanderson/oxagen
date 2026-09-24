// The one 30-day token rollup every Agents figure reads (tokens.ts): the six
// recorded classes summed into input and total, and the three rates that have
// no figure when their denominator is zero, so a page prints "not recorded"
// rather than a division by zero.
import { describe, expect, it } from "vitest";
import { spendRow } from "./agents.builders";
import { TOKEN_CLASSES, tokenRollup } from "./tokens";

describe("tokenRollup", () => {
  it("sums input from its four kinds and total from input, output and reasoning", () => {
    expect(tokenRollup(spendRow())).toEqual({
      total: 6000,
      input: 5000,
      cacheRead: 3000,
      cacheWrite: 1000,
      inputUncached: 1000,
      output: 800,
      reasoning: 200,
      cacheRate: 0.6,
      perRun: 1500,
      perCall: 50,
    });
  });

  it("has no cache rate, per-run or per-call figure when nothing was counted (negative)", () => {
    const rollup = tokenRollup(
      spendRow({
        runs: 0,
        calls: 0,
        tokens: {
          input_uncached: 0,
          cache_read: 0,
          cache_write_5m: 0,
          cache_write_1h: 0,
          output: 12,
          reasoning: 0,
        },
      }),
    );
    expect(rollup.total).toBe(12);
    expect(rollup.input).toBe(0);
    expect(rollup.cacheRate).toBeNull();
    expect(rollup.perRun).toBeNull();
    expect(rollup.perCall).toBeNull();
  });

  it("rounds the per-run and per-call means to whole tokens", () => {
    const rollup = tokenRollup(spendRow({ runs: 7, calls: 3 }));
    expect(rollup.perRun).toBe(857);
    expect(rollup.perCall).toBe(1667);
  });
});

describe("TOKEN_CLASSES", () => {
  it("records output and reasoning and leaves the six input classes unrecorded", () => {
    expect(
      TOKEN_CLASSES.filter((c) => c.recorded !== null).map((c) => c.key),
    ).toEqual(["output", "reasoning"]);
    expect(TOKEN_CLASSES).toHaveLength(8);
  });
});
