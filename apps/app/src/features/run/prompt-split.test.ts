// The Cost tab's prompt split (#5295): the request windows' composition
// first, the rollup's measured sources without them, and a part nothing
// measured left null, never zero.
import { describe, expect, it } from "vitest";
import {
  inputCostOf,
  promptSplit,
  resultTokensOf,
  shareOf,
  windowAreas,
} from "./prompt-split";
import { contextComposition } from "./run.builders";

const sources = {
  toolDefinitionTokens: 4_000,
  contextFrameTokens: null,
  steeringTokens: 0,
};

describe("promptSplit", () => {
  it("splits by the windows' blocks, each a share of their prompt total", () => {
    expect(promptSplit(contextComposition(), sources, 50_000)).toEqual({
      from: "windows",
      parts: {
        conversation: 6_600,
        context: 3_600,
        definitions: 14_400,
        steering: 1_800,
        system: 3_600,
      },
      whole: 30_000,
    });
  });

  it("falls back to the measured sources, a share of the run's input, with conversation and system null", () => {
    expect(promptSplit(null, sources, 50_000)).toEqual({
      from: "sources",
      parts: {
        conversation: null,
        context: null,
        definitions: 4_000,
        // A measured zero stays a zero.
        steering: 0,
        system: null,
      },
      whole: 50_000,
    });
  });

  // #5339. A Claude Code session recorded through its hooks alone carries
  // the steering and the context Oxagen's hooks handed it, and no tool
  // definitions, so Tool definitions stays null and never reads zero.
  it("draws a hook-only session's context and steering, with tool definitions null (negative)", () => {
    const hookOnly = {
      toolDefinitionTokens: null,
      contextFrameTokens: 1_200,
      steeringTokens: 800,
    };
    expect(promptSplit(null, hookOnly, 50_000)).toEqual({
      from: "sources",
      parts: {
        conversation: null,
        context: 1_200,
        definitions: null,
        steering: 800,
        system: null,
      },
      whole: 50_000,
    });
    // A session no hook handed text keeps Context null.
    expect(
      promptSplit(null, { ...hookOnly, contextFrameTokens: null }, 50_000)
        ?.parts.context,
    ).toBeNull();
  });

  it("answers no split when nothing measured one (negative)", () => {
    expect(promptSplit(null, null, 50_000)).toBeNull();
  });
});

describe("shareOf", () => {
  it("divides and caps at the whole", () => {
    expect(shareOf(1_500, 6_000)).toBe(0.25);
    expect(shareOf(9_000, 6_000)).toBe(1);
  });

  it("has no share without a part or a whole (negative)", () => {
    expect(shareOf(null, 6_000)).toBeNull();
    expect(shareOf(10, null)).toBeNull();
    expect(shareOf(10, 0)).toBeNull();
  });
});

describe("windowAreas", () => {
  it("takes the first request's conversation as the prompt and every other request's as follow-ups", () => {
    expect(windowAreas(contextComposition())).toEqual({
      initial: 1_200,
      followUp: 5_400,
      system: 3_600,
      definitions: 14_400,
      context: { tokens: 5_400, steering: 1_800, context: 3_600 },
    });
  });

  it("counts every request's conversation as follow-ups when the first reported no total", () => {
    const areas = windowAreas(
      contextComposition({ initialConversationTokens: null }),
    );
    expect(areas?.initial).toBeNull();
    expect(areas?.followUp).toBe(6_600);
  });

  it("leaves Context null when the windows carried neither steering nor context (negative)", () => {
    const areas = windowAreas(
      contextComposition({
        blocks: {
          system: 3_600,
          steering: null,
          tools: 14_400,
          context: null,
          conversation: 12_000,
        },
      }),
    );
    expect(areas?.context).toBeNull();
    expect(windowAreas(null)).toBeNull();
  });

  it("holds the steering alone when the windows carried no context block", () => {
    const areas = windowAreas(
      contextComposition({
        blocks: {
          system: 3_600,
          steering: 1_800,
          tools: 14_400,
          context: null,
          conversation: 10_200,
        },
      }),
    );
    expect(areas?.context).toEqual({
      tokens: 1_800,
      steering: 1_800,
      context: null,
    });
  });
});

describe("inputCostOf", () => {
  const input = { micros: "1000000", currency: "USD" };

  it("apportions the input classes' recorded cost by the tokens' share of the input", () => {
    expect(inputCostOf(2_500, input, 10_000)).toEqual({
      micros: "250000",
      currency: "USD",
    });
  });

  it("has no cost without a price, without input, or past the input it splits (negative)", () => {
    expect(inputCostOf(2_500, null, 10_000)).toBeNull();
    expect(inputCostOf(2_500, input, null)).toBeNull();
    expect(inputCostOf(2_500, input, 0)).toBeNull();
    expect(inputCostOf(20_000, input, 10_000)).toBeNull();
    expect(inputCostOf(null, input, 10_000)).toBeNull();
  });
});

describe("resultTokensOf", () => {
  it("sums the result tokens the tools recorded", () => {
    expect(
      resultTokensOf([
        { resultTokens: 800 },
        { resultTokens: null },
        { resultTokens: 1_200 },
      ]),
    ).toBe(2_000);
  });

  it("answers null when no tool recorded any, never zero (negative)", () => {
    expect(resultTokensOf([{ resultTokens: null }])).toBeNull();
    expect(resultTokensOf([])).toBeNull();
    expect(resultTokensOf(null)).toBeNull();
  });
});
