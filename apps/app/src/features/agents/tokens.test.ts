// The one 30-day token rollup every Agents figure reads (tokens.ts): the six
// recorded classes summed into input and total, the three rates that have
// no figure when their denominator is zero, so a page prints "not recorded"
// rather than a division by zero, and the four prompt sources the row sums
// over the agent's runs (#5295), each null when no run measured it.
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
      // A row read before the sources were summed carries none.
      toolDefinitions: null,
      contextFrames: null,
      steering: null,
      toolResults: null,
    });
  });

  it("carries the prompt sources the row summed over the agent's runs (#5295)", () => {
    const rollup = tokenRollup(
      spendRow({
        tokenSources: {
          toolDefinitionTokens: 18_000,
          contextFrameTokens: null,
          steeringTokens: 0,
          toolResultTokens: 2_000,
        },
      }),
    );
    expect(rollup.toolDefinitions).toBe(18_000);
    expect(rollup.toolResults).toBe(2_000);
    // A measured zero stays a zero, and an unmeasured source stays null.
    expect(rollup.steering).toBe(0);
    expect(rollup.contextFrames).toBeNull();
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
  it("records every class but conversation and system, which no 30-day read sums (#5295)", () => {
    expect(
      TOKEN_CLASSES.filter((c) => c.recorded !== null).map((c) => c.key),
    ).toEqual([
      "toolResults",
      "contextFrames",
      "toolDefinitions",
      "steering",
      "output",
      "reasoning",
    ]);
    expect(
      TOKEN_CLASSES.filter((c) => c.recorded === null).map((c) => c.key),
    ).toEqual(["conversation", "system"]);
    expect(TOKEN_CLASSES).toHaveLength(8);
  });
});
