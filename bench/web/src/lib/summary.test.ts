import { describe, it, expect } from "vitest";
import { deriveProvenance, summarizeRuns } from "./summary";
import type { EvalResult, EvalRun, EvalRunMeta } from "./types";

function runMeta(overrides: Partial<EvalRunMeta> = {}): EvalRunMeta {
  return {
    run_id: "run-1",
    run_group: "",
    agent_name: "oxagen",
    agent_version: "",
    model: "anthropic/claude-sonnet-4.5",
    harness: "swe-bench",
    suite: "swebench-verified",
    suite_version: "",
    git_sha: "abc123",
    git_branch: "main",
    environment: "local",
    graph_code: 1,
    graph_exec: 1,
    graph_mem: 1,
    warm: 0,
    history_depth: 0,
    seed: 0,
    n_tasks: 4,
    n_passed: 3,
    resolved_rate: 0.75,
    metrics: { cost_usd: 1.2, tokens: 400000, wall_s: 2000 },
    labels: {},
    notes: "",
    ...overrides,
  };
}

function result(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    task_id: "astropy__astropy-1",
    passed: 1,
    reward: 1,
    metrics: { cost_usd: 0.3, tokens: 100000, wall_s: 500 },
    labels: {},
    task_group: "",
    repeat_idx: 0,
    ...overrides,
  };
}

function run(meta: Partial<EvalRunMeta>, results: readonly EvalResult[] = []): EvalRun {
  return { schema: "oxagen.eval.v1", run: runMeta(meta), results };
}

describe("deriveProvenance", () => {
  it("returns sample when labels.provenance is sample", () => {
    expect(deriveProvenance(runMeta({ labels: { provenance: "sample" } }))).toEqual({ kind: "sample" });
  });

  it("returns measured with a default reproduce command when unset", () => {
    const provenance = deriveProvenance(runMeta());
    expect(provenance).toMatchObject({
      kind: "measured",
      harness: "swe-bench",
      dataset: "swebench-verified",
      model: "anthropic/claude-sonnet-4.5",
      gitSha: "abc123",
    });
    if (provenance.kind === "measured") {
      expect(provenance.reproduce).toBe("pnpm bench:swe:compare --suite swebench-verified --agent oxagen");
      expect(provenance.runDate).toBe("");
    }
  });

  it("uses explicit run_date and reproduce labels when present", () => {
    const provenance = deriveProvenance(
      runMeta({ labels: { run_date: "2026-06-01", reproduce: "pnpm bench:swe:compare --seed 1" } }),
    );
    if (provenance.kind === "measured") {
      expect(provenance.runDate).toBe("2026-06-01");
      expect(provenance.reproduce).toBe("pnpm bench:swe:compare --seed 1");
    } else {
      throw new Error("expected measured provenance");
    }
  });
});

describe("summarizeRuns", () => {
  it("returns an empty array for no runs", () => {
    expect(summarizeRuns([])).toEqual([]);
  });

  it("computes resolvedRate from n_passed/n_tasks, not the stale label", () => {
    const rows = summarizeRuns([run({ n_tasks: 4, n_passed: 3, resolved_rate: 0.1 })]);
    expect(rows[0]?.resolvedRate).toBe(0.75);
  });

  it("returns resolvedRate 0 when n_tasks is 0 (no divide-by-zero)", () => {
    const rows = summarizeRuns([run({ n_tasks: 0, n_passed: 0 })]);
    expect(rows[0]?.resolvedRate).toBe(0);
  });

  it("averages per-task metrics from results when present", () => {
    const rows = summarizeRuns([
      run({}, [
        result({ metrics: { cost_usd: 0.2, tokens: 100, wall_s: 10 } }),
        result({ metrics: { cost_usd: 0.4, tokens: 300, wall_s: 30 } }),
      ]),
    ]);
    expect(rows[0]?.avgCostUsd).toBeCloseTo(0.3);
    expect(rows[0]?.avgTokens).toBe(200);
    expect(rows[0]?.avgWallS).toBe(20);
  });

  it("reports null averages when there are no per-task results", () => {
    const rows = summarizeRuns([run({}, [])]);
    expect(rows[0]?.avgCostUsd).toBeNull();
    expect(rows[0]?.avgTokens).toBeNull();
    expect(rows[0]?.avgWallS).toBeNull();
  });

  it("ranks by resolved rate descending", () => {
    const rows = summarizeRuns([
      run({ run_id: "a", agent_name: "agent-a", n_tasks: 10, n_passed: 4 }),
      run({ run_id: "b", agent_name: "agent-b", n_tasks: 10, n_passed: 9 }),
    ]);
    expect(rows.map((r) => r.agentName)).toEqual(["agent-b", "agent-a"]);
  });

  it("breaks ties alphabetically by agent name", () => {
    const rows = summarizeRuns([
      run({ run_id: "a", agent_name: "zeta", n_tasks: 10, n_passed: 5 }),
      run({ run_id: "b", agent_name: "alpha", n_tasks: 10, n_passed: 5 }),
    ]);
    expect(rows.map((r) => r.agentName)).toEqual(["alpha", "zeta"]);
  });

  it("marks a controlled head-to-head group when dataset + model match", () => {
    const rows = summarizeRuns([
      run({ run_id: "a", agent_name: "oxagen", suite: "swebench-verified", model: "m1" }),
      run({ run_id: "b", agent_name: "claude-code", suite: "swebench-verified", model: "m1" }),
    ]);
    expect(rows[0]?.controlledGroupKey).toBe("swebench-verified::m1");
    expect(rows[1]?.controlledGroupKey).toBe("swebench-verified::m1");
  });

  it("leaves controlledGroupKey null for a solo dataset+model combo", () => {
    const rows = summarizeRuns([
      run({ run_id: "a", agent_name: "oxagen", suite: "swebench-verified", model: "m1" }),
      run({ run_id: "b", agent_name: "claude-code", suite: "swebench-lite", model: "m2" }),
    ]);
    expect(rows.every((r) => r.controlledGroupKey === null)).toBe(true);
  });
});
