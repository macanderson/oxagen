/**
 * The `type: "result"` JSONL envelope contract the bench adapter parses
 * (`_populate_best_of_n_metadata` in oxagen_agent.py). Guard both the stable
 * base keys and the new `usage` block that makes solve runs cost-observable.
 */
import { describe, it, expect } from "vitest";
import { resultEnvelope } from "./envelope.js";
import type { BestOfNResult } from "../../agent/best-of-n.js";
import type { SolveUsageSummary } from "../../agent/solve-usage.js";

const result: BestOfNResult = {
  winner: {
    id: "candidate-2",
    model: "m",
    diff: "d",
    summary: "s",
    changedFiles: ["a.py", "b.py"],
    steps: 9,
  },
  candidates: [
    {
      id: "candidate-1",
      model: "m",
      diff: "",
      summary: "",
      changedFiles: [],
      steps: 3,
      failed: true,
    },
    {
      id: "candidate-2",
      model: "m",
      diff: "d",
      summary: "s",
      changedFiles: ["a.py", "b.py"],
      steps: 9,
    },
  ],
  selection: {
    winnerId: "candidate-2",
    reasoning: "tests pass",
    ranking: [{ id: "candidate-2", score: 90, note: "pass" }],
    model: "m",
    fallback: false,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  },
  mode: "independent",
};

describe("resultEnvelope", () => {
  it("keeps the stable base contract the adapter already parses", () => {
    const env = resultEnvelope(result);
    expect(env).toMatchObject({
      type: "result",
      winnerId: "candidate-2",
      winnerFiles: ["a.py", "b.py"],
    });
    expect(env["candidates"]).toEqual([
      {
        id: "candidate-1",
        model: "m",
        changedFiles: [],
        steps: 3,
        failed: true,
      },
      {
        id: "candidate-2",
        model: "m",
        changedFiles: ["a.py", "b.py"],
        steps: 9,
        failed: false,
      },
    ]);
    expect(env).not.toHaveProperty("usage");
  });

  it("carries the aggregated usage block when provided — the adapter's cost source", () => {
    const usage: SolveUsageSummary = {
      tokensIn: 100_000,
      tokensOut: 5_000,
      cachedTokens: 30_000,
      costUsd: 0.42,
      modelCalls: 11,
      totalTokens: 105_000,
      steps: 12,
      wallSec: 640.2,
    };
    const env = resultEnvelope(result, usage);
    expect(env["usage"]).toEqual(usage);
    // The exact keys oxagen_agent.py reads.
    expect(env["usage"]).toMatchObject({
      costUsd: 0.42,
      totalTokens: 105_000,
      wallSec: 640.2,
      steps: 12,
    });
  });
});
