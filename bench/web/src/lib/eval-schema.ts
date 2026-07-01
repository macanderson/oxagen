import type { EvalMetrics, EvalResult, EvalRun, EvalRunMeta } from "./types";

/** Thrown by `parseEvalRun` for any document that doesn't match `oxagen.eval.v1`. */
export class EvalSchemaError extends Error {
  constructor(message: string) {
    super(`invalid oxagen.eval.v1 document: ${message}`);
    this.name = "EvalSchemaError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw new EvalSchemaError(`${path}.${key} must be a string, got ${typeof value}`);
  }
  return value;
}

function requireNumber(obj: Record<string, unknown>, key: string, path: string): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new EvalSchemaError(`${path}.${key} must be a finite number, got ${typeof value}`);
  }
  return value;
}

function requireLabels(obj: Record<string, unknown>, path: string): Readonly<Record<string, string>> {
  const value = obj.labels;
  if (!isRecord(value)) {
    throw new EvalSchemaError(`${path}.labels must be an object`);
  }
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") {
      throw new EvalSchemaError(`${path}.labels.${k} must be a string, got ${typeof v}`);
    }
  }
  return value as Readonly<Record<string, string>>;
}

function parseMetrics(obj: Record<string, unknown>, path: string): EvalMetrics {
  const value = obj.metrics;
  if (!isRecord(value)) {
    throw new EvalSchemaError(`${path}.metrics must be an object`);
  }
  return {
    cost_usd: requireNumber(value, "cost_usd", `${path}.metrics`),
    tokens: requireNumber(value, "tokens", `${path}.metrics`),
    wall_s: requireNumber(value, "wall_s", `${path}.metrics`),
  };
}

function parseRunMeta(obj: Record<string, unknown>): EvalRunMeta {
  const path = "run";
  return {
    run_id: requireString(obj, "run_id", path),
    run_group: requireString(obj, "run_group", path),
    agent_name: requireString(obj, "agent_name", path),
    agent_version: requireString(obj, "agent_version", path),
    model: requireString(obj, "model", path),
    harness: requireString(obj, "harness", path),
    suite: requireString(obj, "suite", path),
    suite_version: requireString(obj, "suite_version", path),
    git_sha: requireString(obj, "git_sha", path),
    git_branch: requireString(obj, "git_branch", path),
    environment: requireString(obj, "environment", path),
    graph_code: requireNumber(obj, "graph_code", path),
    graph_exec: requireNumber(obj, "graph_exec", path),
    graph_mem: requireNumber(obj, "graph_mem", path),
    warm: requireNumber(obj, "warm", path),
    history_depth: requireNumber(obj, "history_depth", path),
    seed: requireNumber(obj, "seed", path),
    n_tasks: requireNumber(obj, "n_tasks", path),
    n_passed: requireNumber(obj, "n_passed", path),
    resolved_rate: requireNumber(obj, "resolved_rate", path),
    metrics: parseMetrics(obj, path),
    labels: requireLabels(obj, path),
    notes: requireString(obj, "notes", path),
  };
}

function parseResult(value: unknown, index: number): EvalResult {
  const path = `results[${index}]`;
  if (!isRecord(value)) {
    throw new EvalSchemaError(`${path} must be an object`);
  }
  const passed = requireNumber(value, "passed", path);
  if (passed !== 0 && passed !== 1) {
    throw new EvalSchemaError(`${path}.passed must be 0 or 1, got ${passed}`);
  }
  const taskGroup = value.task_group;
  if (typeof taskGroup !== "string") {
    throw new EvalSchemaError(`${path}.task_group must be a string, got ${typeof taskGroup}`);
  }
  return {
    task_id: requireString(value, "task_id", path),
    passed,
    reward: requireNumber(value, "reward", path),
    metrics: parseMetrics(value, path),
    labels: requireLabels(value, path),
    task_group: taskGroup,
    repeat_idx: requireNumber(value, "repeat_idx", path),
  };
}

/**
 * Strictly parse a JSON value into an `EvalRun`. Rejects anything that isn't a
 * well-formed `oxagen.eval.v1` document with a clear, field-level error message
 * — the loader (`results.ts`) fails fast on a malformed committed file rather
 * than silently dropping or guessing at it.
 */
export function parseEvalRun(json: unknown): EvalRun {
  if (!isRecord(json)) {
    throw new EvalSchemaError("document must be an object");
  }
  if (json.schema !== "oxagen.eval.v1") {
    throw new EvalSchemaError(`schema must be "oxagen.eval.v1", got ${JSON.stringify(json.schema)}`);
  }
  if (!isRecord(json.run)) {
    throw new EvalSchemaError("run must be an object");
  }
  const run = parseRunMeta(json.run);

  if (!Array.isArray(json.results)) {
    throw new EvalSchemaError("results must be an array");
  }
  const results = json.results.map((r, i) => parseResult(r, i));

  return { schema: "oxagen.eval.v1", run, results };
}
