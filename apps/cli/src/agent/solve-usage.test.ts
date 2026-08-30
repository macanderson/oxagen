/**
 * Solve-path usage aggregation — the math behind `oxagen solve`'s cost
 * reporting (Bug: the best-of-N path used to emit no metering at all; the
 * bench adapter parsed null cost for every solve trial).
 */
import { describe, it, expect } from "vitest";
import {
  createSolveUsageAccumulator,
  buildSolveUsageSummary,
  totalSolveSteps,
  formatSolveRollup,
  type SolveUsageSummary,
} from "./solve-usage.js";
import type { MetricsEvent } from "./metrics.js";
import type { BestOfNResult } from "./best-of-n.js";

function ev(over: Partial<MetricsEvent>): MetricsEvent {
  return {
    callId: "model-1",
    kind: "model_call",
    model: "anthropic/claude-fable-5",
    tokensIn: 0,
    tokensOut: 0,
    cachedTokens: 0,
    costUsd: 0,
    at: 0,
    ...over,
  };
}

function fakeResult(over: Partial<BestOfNResult> = {}): BestOfNResult {
  return {
    winner: null,
    candidates: [
      {
        id: "candidate-1",
        model: "m",
        diff: "",
        summary: "",
        changedFiles: [],
        steps: 12,
      },
      {
        id: "candidate-2",
        model: "m",
        diff: "",
        summary: "",
        changedFiles: [],
        steps: 8,
      },
      {
        id: "candidate-3",
        model: "m",
        diff: "",
        summary: "",
        changedFiles: [],
        steps: 0,
        failed: true,
      },
    ],
    selection: {
      winnerId: "candidate-1",
      reasoning: "",
      ranking: [],
      model: "m",
      fallback: false,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    },
    mode: "independent",
    ...over,
  };
}

describe("createSolveUsageAccumulator", () => {
  it("sums tokens, cache reads, and cost across every model call", () => {
    const acc = createSolveUsageAccumulator();
    // Candidate turns + a pipeline judge + the comparative selector.
    acc.record(
      ev({
        tokensIn: 10_000,
        tokensOut: 2_000,
        cachedTokens: 4_000,
        costUsd: 0.12,
      }),
    );
    acc.record(
      ev({ tokensIn: 8_000, tokensOut: 1_500, cachedTokens: 0, costUsd: 0.09 }),
    );
    acc.record(
      ev({
        tokensIn: 3_000,
        tokensOut: 400,
        cachedTokens: 1_000,
        costUsd: 0.03,
        model: "openai/gpt-5.5-pro",
      }),
    );
    expect(acc.totals()).toEqual({
      tokensIn: 21_000,
      tokensOut: 3_900,
      cachedTokens: 5_000,
      costUsd: 0.12 + 0.09 + 0.03,
      modelCalls: 3,
    });
  });

  it("ignores tool_call events (they carry no token usage)", () => {
    const acc = createSolveUsageAccumulator();
    acc.record(
      ev({ kind: "tool_call", tokensIn: 999, tokensOut: 999, costUsd: 9 }),
    );
    expect(acc.totals()).toEqual({
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      costUsd: 0,
      modelCalls: 0,
    });
  });

  it("totals() returns a snapshot copy, not live internal state", () => {
    const acc = createSolveUsageAccumulator();
    acc.record(ev({ tokensIn: 100, costUsd: 0.01 }));
    const snap = acc.totals();
    acc.record(ev({ tokensIn: 100, costUsd: 0.01 }));
    expect(snap.tokensIn).toBe(100);
    expect(acc.totals().tokensIn).toBe(200);
  });
});

describe("totalSolveSteps", () => {
  it("sums steps across every candidate (failed ones contribute their 0)", () => {
    expect(totalSolveSteps(fakeResult())).toBe(20);
  });

  it("includes fork mode's trunk steps", () => {
    const result = fakeResult({
      mode: "fork",
      forkTelemetry: {
        trunkSteps: 7,
        hypothesesCount: 2,
        fallbackToIndependent: false,
        selectionMethod: "consensus",
      },
    });
    expect(totalSolveSteps(result)).toBe(27);
  });
});

describe("buildSolveUsageSummary", () => {
  it("derives totalTokens, steps, and wallSec from the settled totals", () => {
    const totals = {
      tokensIn: 80_000,
      tokensOut: 3_086,
      cachedTokens: 20_000,
      costUsd: 0.2714,
      modelCalls: 9,
    };
    const s = buildSolveUsageSummary(totals, fakeResult(), 815_530);
    expect(s).toMatchObject({
      ...totals,
      totalTokens: 83_086,
      steps: 20,
      wallSec: 815.53,
    });
  });

  it("clamps a negative wall duration to zero", () => {
    const totals = {
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      costUsd: 0,
      modelCalls: 0,
    };
    expect(buildSolveUsageSummary(totals, fakeResult(), -50).wallSec).toBe(0);
  });
});

describe("formatSolveRollup", () => {
  const summary: SolveUsageSummary = {
    tokensIn: 80_000,
    tokensOut: 3_086,
    cachedTokens: 20_000,
    costUsd: 0.2714,
    modelCalls: 9,
    totalTokens: 83_086,
    steps: 37,
    wallSec: 815.53,
  };

  it("renders the one-shot efficiency format", () => {
    expect(formatSolveRollup(summary)).toBe(
      "815.53s total · 83086 tok · $0.2714 · 37 steps",
    );
  });

  it("matches the bench adapter's parse regexes exactly (oxagen_agent.py)", () => {
    const line = formatSolveRollup(summary);
    // The two regexes `populate_context_post_run` uses for the one-shot path.
    const m = /([\d.]+)s total\D+([\d,]+)\s*tok\D+\$([\d.]+)/.exec(line);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeCloseTo(815.53);
    expect(Number(m![2]!.replace(/,/g, ""))).toBe(83_086);
    expect(Number(m![3])).toBeCloseTo(0.2714);
    const steps = /(\d+)\s*steps/.exec(line);
    expect(Number(steps![1])).toBe(37);
  });
});
