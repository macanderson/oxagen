import { describe, it, expect } from "vitest";
import { loadEvalRuns } from "./results";
import { EvalSchemaError } from "./eval-schema";

const VALID_DOC = {
  schema: "oxagen.eval.v1",
  run: {
    run_id: "run-1",
    run_group: "",
    agent_name: "oxagen",
    agent_version: "",
    model: "anthropic/claude-sonnet-5",
    harness: "swe-bench",
    suite: "swebench-verified",
    suite_version: "",
    git_sha: "",
    git_branch: "",
    environment: "local",
    graph_code: 1,
    graph_exec: 1,
    graph_mem: 1,
    warm: 0,
    history_depth: 0,
    seed: 0,
    n_tasks: 0,
    n_passed: 0,
    resolved_rate: 0,
    metrics: { cost_usd: 0, tokens: 0, wall_s: 0 },
    labels: { provenance: "sample" },
    notes: "",
  },
  results: [],
};

describe("loadEvalRuns", () => {
  it("returns an empty array for an empty batch", () => {
    expect(loadEvalRuns([])).toEqual([]);
  });

  it("validates and returns every well-formed document", () => {
    const runs = loadEvalRuns([VALID_DOC, VALID_DOC]);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.run.run_id).toBe("run-1");
  });

  it("fails fast on the first malformed document", () => {
    expect(() => loadEvalRuns([VALID_DOC, { schema: "wrong" }])).toThrow(EvalSchemaError);
  });
});
