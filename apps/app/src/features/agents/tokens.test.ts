// The one 30-day token rollup every Agents figure reads (tokens.ts): the six
// recorded classes summed into input and total, the three rates that have
// no figure when their denominator is zero, so a page prints "not recorded"
// rather than a division by zero, the four prompt sources the row sums over
// the agent's runs (#5295), and conversation and system from the runs'
// request windows (#5341), each null when no run measured it.
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
      // A row read before the sources and windows were summed carries none.
      conversation: null,
      system: null,
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

  it("carries conversation and system from the runs' request windows (#5341)", () => {
    const rollup = tokenRollup(
      spendRow({
        windows: {
          runs: 3,
          requests: 40,
          requestsWithoutTokens: 0,
          promptTokens: 4_000,
          blocks: {
            system: 600,
            steering: null,
            tools: 1_400,
            context: null,
            conversation: 2_000,
          },
        },
      }),
    );
    expect(rollup.conversation).toBe(2_000);
    expect(rollup.system).toBe(600);
    // The windows' tools block is not the measured tool definitions.
    expect(rollup.toolDefinitions).toBeNull();
  });

  it("leaves conversation and system null when no run stored windows (negative)", () => {
    const rollup = tokenRollup(spendRow({ windows: null }));
    expect(rollup.conversation).toBeNull();
    expect(rollup.system).toBeNull();
    const noSystem = tokenRollup(
      spendRow({
        windows: {
          runs: 1,
          requests: 1,
          requestsWithoutTokens: 0,
          promptTokens: 900,
          blocks: {
            system: null,
            steering: null,
            tools: null,
            context: null,
            conversation: 900,
          },
        },
      }),
    );
    expect(noSystem.conversation).toBe(900);
    expect(noSystem.system).toBeNull();
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
  it("backs every one of the design's eight classes with a rollup field (#5341)", () => {
    expect(TOKEN_CLASSES.map((c) => [c.key, c.recorded])).toEqual([
      ["conversation", "conversation"],
      ["toolResults", "toolResults"],
      ["contextFrames", "contextFrames"],
      ["toolDefinitions", "toolDefinitions"],
      ["steering", "steering"],
      ["system", "system"],
      ["output", "output"],
      ["reasoning", "reasoning"],
    ]);
  });
});
