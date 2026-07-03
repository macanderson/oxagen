import { describe, it, expect } from "vitest";
import { EvalSchemaError, parseEvalRun } from "./eval-schema";

function validDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "oxagen.eval.v1",
    run: {
      run_id: "swe-bench-001",
      run_group: "",
      agent_name: "oxagen",
      agent_version: "",
      model: "anthropic/claude-sonnet-5",
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
      n_tasks: 1,
      n_passed: 1,
      resolved_rate: 1.0,
      metrics: { cost_usd: 0.27, tokens: 83000, wall_s: 815 },
      labels: {},
      notes: "",
    },
    results: [
      {
        task_id: "astropy__astropy-12345",
        passed: 1,
        reward: 1.0,
        metrics: { cost_usd: 0.27, tokens: 83000, wall_s: 815 },
        labels: { trial_name: "t1", exception: "" },
        task_group: "",
        repeat_idx: 0,
      },
    ],
    ...overrides,
  };
}

describe("parseEvalRun", () => {
  it("parses a valid oxagen.eval.v1 document", () => {
    const run = parseEvalRun(validDoc());
    expect(run.schema).toBe("oxagen.eval.v1");
    expect(run.run.agent_name).toBe("oxagen");
    expect(run.results).toHaveLength(1);
    expect(run.results[0]?.task_id).toBe("astropy__astropy-12345");
  });

  it("rejects a non-object document", () => {
    expect(() => parseEvalRun("not an object")).toThrow(EvalSchemaError);
    expect(() => parseEvalRun(null)).toThrow(EvalSchemaError);
    expect(() => parseEvalRun([])).toThrow(EvalSchemaError);
  });

  it("rejects the wrong schema tag", () => {
    expect(() => parseEvalRun(validDoc({ schema: "oxagen.eval.v2" }))).toThrow(/schema must be/);
  });

  it("rejects a missing run object", () => {
    expect(() => parseEvalRun(validDoc({ run: null }))).toThrow(/run must be an object/);
  });

  it("rejects a run with a missing string field", () => {
    const doc = validDoc();
    const run = doc.run as Record<string, unknown>;
    delete run.agent_name;
    expect(() => parseEvalRun(doc)).toThrow(/run.agent_name must be a string/);
  });

  it("rejects a run with a non-numeric field", () => {
    const doc = validDoc();
    (doc.run as Record<string, unknown>).n_tasks = "5";
    expect(() => parseEvalRun(doc)).toThrow(/run.n_tasks must be a finite number/);
  });

  it("rejects a non-finite numeric field", () => {
    const doc = validDoc();
    (doc.run as Record<string, unknown>).n_tasks = Number.POSITIVE_INFINITY;
    expect(() => parseEvalRun(doc)).toThrow(/run.n_tasks must be a finite number/);
  });

  it("rejects a run with malformed metrics", () => {
    const doc = validDoc();
    (doc.run as Record<string, unknown>).metrics = { cost_usd: 0.1 };
    expect(() => parseEvalRun(doc)).toThrow(/metrics.tokens must be a finite number/);
  });

  it("rejects a run whose metrics is not an object", () => {
    const doc = validDoc();
    (doc.run as Record<string, unknown>).metrics = "none";
    expect(() => parseEvalRun(doc)).toThrow(/run.metrics must be an object/);
  });

  it("rejects a run with a non-object labels", () => {
    const doc = validDoc();
    (doc.run as Record<string, unknown>).labels = "sample";
    expect(() => parseEvalRun(doc)).toThrow(/run.labels must be an object/);
  });

  it("rejects labels with a non-string value", () => {
    const doc = validDoc();
    (doc.run as Record<string, unknown>).labels = { provenance: 1 };
    expect(() => parseEvalRun(doc)).toThrow(/run.labels.provenance must be a string/);
  });

  it("accepts string-valued labels", () => {
    const doc = validDoc();
    (doc.run as Record<string, unknown>).labels = { provenance: "sample" };
    const run = parseEvalRun(doc);
    expect(run.run.labels.provenance).toBe("sample");
  });

  it("rejects a non-array results field", () => {
    expect(() => parseEvalRun(validDoc({ results: "nope" }))).toThrow(/results must be an array/);
  });

  it("rejects a non-object result entry", () => {
    expect(() => parseEvalRun(validDoc({ results: ["nope"] }))).toThrow(/results\[0\] must be an object/);
  });

  it("rejects a result with an out-of-range passed value", () => {
    const doc = validDoc();
    (doc.results as Record<string, unknown>[])[0]!.passed = 2;
    expect(() => parseEvalRun(doc)).toThrow(/results\[0\].passed must be 0 or 1/);
  });

  it("rejects a result with a non-string task_group", () => {
    const doc = validDoc();
    (doc.results as Record<string, unknown>[])[0]!.task_group = 42;
    expect(() => parseEvalRun(doc)).toThrow(/results\[0\].task_group must be a string/);
  });

  it("rejects a result with malformed metrics", () => {
    const doc = validDoc();
    (doc.results as Record<string, unknown>[])[0]!.metrics = { cost_usd: 0.1, tokens: 1 };
    expect(() => parseEvalRun(doc)).toThrow(/results\[0\].metrics.wall_s must be a finite number/);
  });

  it("rejects a result with a missing field", () => {
    const doc = validDoc();
    delete (doc.results as Record<string, unknown>[])[0]!.task_id;
    expect(() => parseEvalRun(doc)).toThrow(/results\[0\].task_id must be a string/);
  });

  it("accepts an empty results array", () => {
    const run = parseEvalRun(validDoc({ results: [] }));
    expect(run.results).toEqual([]);
  });
});
