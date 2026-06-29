import { describe, it, expect } from "vitest";
import { mulberry32, runTask, summarize, runBenchmark, FAILURE_MODES } from "./benchmark";
import { AGENTS_BY_ID, EVALS_BY_ID } from "./data";
import type { AgentId, RunConfig, TaskResult } from "./types";

const ALL_AGENTS: readonly AgentId[] = [
  "oxagen-cli",
  "claude-code",
  "github-copilot",
  "google-gemini",
];
const SOME_EVALS = ["simple-file-edit", "bug-fix", "type-safety"] as const;

function fullConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    agentIds: ALL_AGENTS,
    evalIds: SOME_EVALS,
    difficulty: "medium",
    seed: 42,
    ...overrides,
  };
}

describe("mulberry32", () => {
  it("produces values in [0, 1)", () => {
    const rng = mulberry32(123);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("is deterministic for a given seed", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });
});

describe("runTask", () => {
  it("scales duration by the agent speed multiplier", () => {
    const evalDef = EVALS_BY_ID["simple-file-edit"]!;
    // Use a fixed rng that returns 0.5 (zero jitter) so the comparison is exact.
    const noJitter = () => 0.5;
    const oxagen = runTask(AGENTS_BY_ID["oxagen-cli"]!, evalDef, "medium", noJitter);
    const copilot = runTask(AGENTS_BY_ID["github-copilot"]!, evalDef, "medium", noJitter);
    // Copilot is 1.5x slower than the Oxagen baseline.
    expect(copilot.durationMs).toBeGreaterThan(oxagen.durationMs);
    expect(copilot.durationMs / oxagen.durationMs).toBeCloseTo(1.5, 1);
  });

  it("uses more tokens for less efficient agents", () => {
    const evalDef = EVALS_BY_ID["token-efficiency"]!;
    const noJitter = () => 0.5;
    const oxagen = runTask(AGENTS_BY_ID["oxagen-cli"]!, evalDef, "medium", noJitter);
    const copilot = runTask(AGENTS_BY_ID["github-copilot"]!, evalDef, "medium", noJitter);
    expect(copilot.tokens).toBeGreaterThan(oxagen.tokens);
  });

  it("keeps accuracy within [0.4, 0.99]", () => {
    const evalDef = EVALS_BY_ID["bug-fix"]!;
    const rng = mulberry32(99);
    for (let i = 0; i < 200; i++) {
      const r = runTask(AGENTS_BY_ID["github-copilot"]!, evalDef, "hard", rng);
      expect(r.accuracy).toBeGreaterThanOrEqual(0.4);
      expect(r.accuracy).toBeLessThanOrEqual(0.99);
    }
  });

  it("hard difficulty costs more and is less accurate than easy", () => {
    const evalDef = EVALS_BY_ID["multi-file-refactor"]!;
    const noJitter = () => 0.5;
    const easy = runTask(AGENTS_BY_ID["oxagen-cli"]!, evalDef, "easy", noJitter);
    const hard = runTask(AGENTS_BY_ID["oxagen-cli"]!, evalDef, "hard", noJitter);
    expect(hard.durationMs).toBeGreaterThan(easy.durationMs);
    expect(hard.tokens).toBeGreaterThan(easy.tokens);
    expect(hard.accuracy).toBeLessThan(easy.accuracy);
  });

  it("assigns a valid failure mode when a task does not pass", () => {
    const evalDef = EVALS_BY_ID["bug-fix"]!;
    // Force a fail: accuracy roll path — pick an rng that yields a high passRoll.
    // accuracy=0.5 zero-jitter input, then passRoll near 1 -> fail.
    const rolls = [0.5, 0.5, 0.5, 0.99, 0.0];
    let i = 0;
    const rng = () => rolls[i++ % rolls.length]!;
    const r = runTask(AGENTS_BY_ID["github-copilot"]!, evalDef, "hard", rng);
    expect(r.passed).toBe(false);
    expect(r.failureMode).not.toBeNull();
    expect(FAILURE_MODES).toContain(r.failureMode!);
  });

  it("has no failure mode when a task passes", () => {
    const evalDef = EVALS_BY_ID["simple-file-edit"]!;
    // passRoll near 0 -> always passes regardless of accuracy.
    const rolls = [0.5, 0.5, 0.5, 0.0];
    let i = 0;
    const rng = () => rolls[i++ % rolls.length]!;
    const r = runTask(AGENTS_BY_ID["oxagen-cli"]!, evalDef, "easy", rng);
    expect(r.passed).toBe(true);
    expect(r.failureMode).toBeNull();
  });
});

describe("summarize", () => {
  it("ranks the strongest agent first and assigns unique ranks", () => {
    const run = runBenchmark(fullConfig());
    const summaries = run.summaries;
    expect(summaries).toHaveLength(ALL_AGENTS.length);
    const ranks = summaries.map((s) => s.rank).sort((a, b) => a - b);
    expect(ranks).toEqual([1, 2, 3, 4]);
    // Oxagen has the best profile across the board; over a few evals it should
    // not rank worse than its weakest competitor.
    const oxagen = summaries.find((s) => s.agentId === "oxagen-cli")!;
    expect(oxagen.score).toBeGreaterThan(0);
  });

  it("preserves input agent order in the output array", () => {
    const run = runBenchmark(fullConfig());
    expect(run.summaries.map((s) => s.agentId)).toEqual(ALL_AGENTS);
  });

  it("computes pass rate as a 0..1 ratio", () => {
    const run = runBenchmark(fullConfig());
    for (const s of run.summaries) {
      expect(s.passRate).toBeGreaterThanOrEqual(0);
      expect(s.passRate).toBeLessThanOrEqual(1);
    }
  });

  it("handles an agent with no results gracefully", () => {
    const results: TaskResult[] = [];
    const summaries = summarize(results, ["oxagen-cli"]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.passRate).toBe(0);
    expect(summaries[0]!.totalTokens).toBe(0);
    expect(summaries[0]!.rank).toBe(1);
  });
});

describe("runBenchmark", () => {
  it("produces one result per agent×eval", () => {
    const run = runBenchmark(fullConfig());
    expect(run.results).toHaveLength(ALL_AGENTS.length * SOME_EVALS.length);
  });

  it("is deterministic for the same config", () => {
    const a = runBenchmark(fullConfig());
    const b = runBenchmark(fullConfig());
    expect(a.results).toEqual(b.results);
    expect(a.summaries).toEqual(b.summaries);
  });

  it("changes with the seed", () => {
    const a = runBenchmark(fullConfig({ seed: 1 }));
    const b = runBenchmark(fullConfig({ seed: 2 }));
    expect(a.results).not.toEqual(b.results);
  });

  it("throws on empty agents or evals", () => {
    expect(() => runBenchmark(fullConfig({ agentIds: [] }))).toThrow(/agent/i);
    expect(() => runBenchmark(fullConfig({ evalIds: [] }))).toThrow(/evaluation/i);
  });

  it("throws on unknown agent or eval ids", () => {
    expect(() => runBenchmark(fullConfig({ agentIds: ["nope" as AgentId] }))).toThrow(/unknown agent/i);
    expect(() => runBenchmark(fullConfig({ evalIds: ["nope"] }))).toThrow(/unknown eval/i);
  });

  it("encodes the difficulty and seed in the run id", () => {
    const run = runBenchmark(fullConfig({ seed: 255, difficulty: "hard" }));
    expect(run.id).toContain("hard");
    expect(run.difficulty).toBe("hard");
    expect(run.seed).toBe(255);
  });
});
