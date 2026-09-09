import type { ContextFrame } from "@contextgraphprotocol/typescript-sdk";
import { describe, expect, it } from "vitest";
import { packWithinBudget } from "./budget";

function frame(id: string, score: number, cost: number): ContextFrame {
  return {
    id,
    kind: "fact",
    title: id,
    content: "x".repeat(cost * 4),
    score,
    token_cost: cost,
  };
}

describe("packWithinBudget", () => {
  it("returns the best frames first", () => {
    const result = packWithinBudget(
      [frame("low", 0.1, 1), frame("high", 0.9, 1), frame("mid", 0.5, 1)],
      { maxFrames: 3, maxTokens: 100 },
    );
    expect(result.frames.map((f) => f.id)).toEqual(["high", "mid", "low"]);
    expect(result.truncated).toBe(false);
    expect(result.dropped_estimate).toBeUndefined();
  });

  it("stops at max_frames and says it truncated", () => {
    const result = packWithinBudget(
      [frame("a", 0.9, 1), frame("b", 0.8, 1), frame("c", 0.7, 1)],
      { maxFrames: 2, maxTokens: 100 },
    );
    expect(result.frames).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.dropped_estimate).toBe(1);
  });

  it("never spends more than max_tokens", () => {
    const result = packWithinBudget(
      [frame("a", 0.9, 30), frame("b", 0.8, 30), frame("c", 0.7, 30)],
      { maxFrames: 10, maxTokens: 70 },
    );
    const spent = result.frames.reduce((sum, f) => sum + f.token_cost, 0);
    expect(spent).toBeLessThanOrEqual(70);
    expect(result.frames).toHaveLength(2);
  });

  // The reason the walk skips rather than stops.
  it("keeps filling the budget past a frame too large to fit", () => {
    const result = packWithinBudget(
      [frame("huge", 0.99, 500), frame("small", 0.5, 10)],
      { maxFrames: 5, maxTokens: 100 },
    );
    expect(result.frames.map((f) => f.id)).toEqual(["small"]);
    expect(result.truncated).toBe(true);
    expect(result.dropped_estimate).toBe(1);
  });

  it("orders ties by id, so the same query answers the same way twice", () => {
    const forwards = packWithinBudget(
      [frame("b", 0.5, 1), frame("a", 0.5, 1)],
      { maxFrames: 1, maxTokens: 100 },
    );
    const backwards = packWithinBudget(
      [frame("a", 0.5, 1), frame("b", 0.5, 1)],
      { maxFrames: 1, maxTokens: 100 },
    );
    expect(forwards.frames[0]?.id).toBe("a");
    expect(backwards.frames[0]?.id).toBe("a");
  });

  it("returns nothing for a budget of nothing", () => {
    const frames = [frame("a", 0.9, 1)];
    expect(
      packWithinBudget(frames, { maxFrames: 0, maxTokens: 100 }).frames,
    ).toHaveLength(0);
    expect(
      packWithinBudget(frames, { maxFrames: 5, maxTokens: 0 }).frames,
    ).toHaveLength(0);
  });

  it("does not mutate the caller's array", () => {
    const frames = [frame("b", 0.1, 1), frame("a", 0.9, 1)];
    packWithinBudget(frames, { maxFrames: 2, maxTokens: 10 });
    expect(frames.map((f) => f.id)).toEqual(["b", "a"]);
  });

  it("admits a zero-cost frame against a spent budget", () => {
    const result = packWithinBudget(
      [frame("paid", 0.9, 10), frame("free", 0.1, 0)],
      { maxFrames: 5, maxTokens: 10 },
    );
    expect(result.frames.map((f) => f.id)).toEqual(["paid", "free"]);
    expect(result.truncated).toBe(false);
  });
});
