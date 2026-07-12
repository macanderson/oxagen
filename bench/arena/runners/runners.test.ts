/**
 * Runner unit tests.
 *
 * The pure command-building / model-resolution / envelope-parsing helpers are
 * tested directly. The end-to-end execution flow (seed workspace → spawn →
 * diff → verify → parse) is exercised through a FakeRunner that drives `sh` as
 * a stand-in agent, so no real agent binary or API key is required.
 */

import { describe, expect, it } from "vitest";

import type { AgentConfig, Metrics, Task } from "../src/lib/types.js";
import { BaseAgentRunner } from "./agent-runner.js";
import {
  buildTaskPrompt,
  countOf,
  num,
  parseJsonEnvelope,
  sanitizeSegment,
} from "./lib.js";
import {
  buildOxagenArgs,
  parseOxagenMetrics,
  resolveOxagenModel,
} from "./oxagen-runner.js";
import {
  buildStellaArgs,
  parseStellaMetrics,
  resolveStellaModel,
} from "./stella-runner.js";
import {
  buildClaudeArgs,
  parseClaudeMetrics,
  resolveClaudeModel,
} from "./claude-code-runner.js";

const task: Task = {
  id: "smoke-add-error-handling",
  name: "Add Error Handling",
  category: "bug-fix",
  difficulty: "intermediate",
  ecosystem: "typescript",
  estimatedTokens: 8000,
  estimatedCost: 0.08,
  description: "Add try-catch around an unguarded API call.",
  acceptanceCriteria: ["API call is wrapped in try-catch", "Errors are logged"],
  startingPoint: "An API endpoint making an unguarded async call",
  filesToModify: ["src/api/users.ts"],
  testCommands: ["true"],
  tags: ["smoke"],
};

const config: AgentConfig = {
  type: "oxagen",
  model: "anthropic/claude-opus-4.8",
  budget: 25,
  timeout: 30,
};

describe("lib helpers", () => {
  it("sanitizeSegment strips path separators from model slugs", () => {
    expect(sanitizeSegment("anthropic/claude-opus-4.8")).toBe(
      "anthropic_claude-opus-4.8",
    );
    expect(sanitizeSegment("glm-5.2")).toBe("glm-5.2");
    expect(sanitizeSegment("a/b/c")).toBe("a_b_c");
  });

  it("num coerces only finite numbers", () => {
    expect(num(42)).toBe(42);
    expect(num("42")).toBe(0);
    expect(num(undefined, 7)).toBe(7);
    expect(num(NaN, 3)).toBe(3);
  });

  it("countOf returns array length or numeric count", () => {
    expect(countOf(["a", "b"])).toBe(2);
    expect(countOf(5)).toBe(5);
    expect(countOf(undefined)).toBe(0);
  });

  it("buildTaskPrompt includes description, files, criteria and verify cmds", () => {
    const prompt = buildTaskPrompt(task);
    expect(prompt).toContain("# Add Error Handling");
    expect(prompt).toContain("Add try-catch around an unguarded API call.");
    expect(prompt).toContain("- src/api/users.ts");
    expect(prompt).toContain("- API call is wrapped in try-catch");
    expect(prompt).toContain("`true`");
  });

  it("parseJsonEnvelope finds the last result line amid noise", () => {
    const stdout = [
      "npm warn something",
      '{"type":"stage","label":"plan"}',
      '{"type":"result","ok":true,"steps":3}',
      "trailing log line",
    ].join("\n");
    const env = parseJsonEnvelope(stdout);
    expect(env?.type).toBe("result");
    expect(env?.steps).toBe(3);
  });

  it("parseJsonEnvelope falls back to last JSON object when no result type", () => {
    expect(parseJsonEnvelope('{"a":1}\n{"b":2}')?.b).toBe(2);
    expect(parseJsonEnvelope("")).toBeNull();
    expect(parseJsonEnvelope("no json here")).toBeNull();
  });
});

describe("oxagen runner helpers", () => {
  it("passes gateway slugs through unchanged", () => {
    expect(resolveOxagenModel("anthropic/claude-opus-4.8")).toBe(
      "anthropic/claude-opus-4.8",
    );
  });

  it("builds one-shot argv with -- guarding the prompt", () => {
    const args = buildOxagenArgs("do the thing", "anthropic/claude-opus-4.8", config);
    expect(args).toContain("--local");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args.slice(-2)).toEqual(["--", "do the thing"]);
    expect(args).toContain("--budget");
    expect(args[args.indexOf("--budget") + 1]).toBe("25");
  });

  it("adds --max-steps when maxIterations is configured", () => {
    const args = buildOxagenArgs("p", "m", {
      ...config,
      config: { maxIterations: 8 },
    });
    expect(args[args.indexOf("--max-steps") + 1]).toBe("8");
  });

  it("parses usage + derives cost from the rate card", () => {
    const stdout = JSON.stringify({
      type: "result",
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
      steps: 4,
      filesTouched: ["a.ts", "b.ts"],
      commandsRun: ["tsc"],
    });
    const calc = (i: number, o: number) => i / 1000 + o / 1000;
    const m = parseOxagenMetrics(stdout, Date.now(), config, calc);
    expect(m.totalTokens).toBe(2_000_000);
    expect(m.filesTouched).toBe(2);
    expect(m.toolCalls).toBe(1);
    expect(m.iterations).toBe(4);
    expect(m.totalCost).toBe(2000);
  });

  it("returns duration-only metrics on unparseable output", () => {
    const m = parseOxagenMetrics("garbage", Date.now(), config, () => 0);
    expect(m.totalTokens).toBeUndefined();
    expect(m.durationSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe("stella runner helpers", () => {
  it("prefixes bare glm ids with the zai provider", () => {
    expect(resolveStellaModel("glm-5.2")).toBe("zai/glm-5.2");
    expect(resolveStellaModel("anthropic/claude-fable-5")).toBe(
      "anthropic/claude-fable-5",
    );
  });

  it("uses the run subcommand with the prompt positional", () => {
    expect(buildStellaArgs("fix it")).toEqual(["run", "fix it"]);
  });

  it("reads snake_case and camelCase token fields", () => {
    const stdout = JSON.stringify({
      type: "result",
      usage: { input_tokens: 10, output_tokens: 5 },
      cost_usd: 0.02,
      files_touched: 2,
    });
    const m = parseStellaMetrics(stdout, Date.now());
    expect(m.inputTokens).toBe(10);
    expect(m.outputTokens).toBe(5);
    expect(m.totalTokens).toBe(15);
    expect(m.totalCost).toBe(0.02);
    expect(m.filesTouched).toBe(2);
  });
});

describe("claude-code runner helpers", () => {
  it("maps model slugs to CLI aliases", () => {
    expect(resolveClaudeModel("anthropic/claude-opus-4.8")).toBe("opus");
    expect(resolveClaudeModel("claude-sonnet-5")).toBe("sonnet");
    expect(resolveClaudeModel("claude-haiku-4.5")).toBe("haiku");
    expect(resolveClaudeModel("some-custom-model")).toBe("some-custom-model");
  });

  it("builds print-mode argv with budget + trailing prompt", () => {
    const args = buildClaudeArgs("fix it", "opus", config);
    expect(args[0]).toBe("-p");
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("25");
    expect(args[args.length - 1]).toBe("fix it");
  });

  it("parses total_cost_usd + usage token fields", () => {
    const stdout = JSON.stringify({
      type: "result",
      total_cost_usd: 0.5,
      num_turns: 6,
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 20 },
    });
    const m = parseClaudeMetrics(stdout, Date.now());
    expect(m.totalCost).toBe(0.5);
    expect(m.iterations).toBe(6);
    expect(m.totalTokens).toBe(140);
    expect(m.cacheReadTokens).toBe(20);
  });
});

/** Drives `sh` as a stand-in agent to exercise the full execution flow. */
class FakeRunner extends BaseAgentRunner {
  agentType = "custom" as const;
  constructor(private readonly script: string) {
    super();
  }
  protected binary(): string {
    return "sh";
  }
  protected resolveModel(model: string): string {
    return model;
  }
  protected buildArgs(): string[] {
    return ["-c", this.script];
  }
  protected parseMetrics(stdout: string, startTime: number): Partial<Metrics> {
    const env = parseJsonEnvelope(stdout);
    return {
      totalTokens: num(env?.total),
      durationSeconds: (Date.now() - startTime) / 1000,
    };
  }
}

describe("BaseAgentRunner execution flow", () => {
  it("seeds, runs, diffs and reports success when tests pass", async () => {
    const runner = new FakeRunner(
      "printf 'guarded\\n' >> src/api/users.ts; echo '{\"type\":\"result\",\"total\":12}'",
    );
    const result = await runner.runTask(task, config);
    expect(result.metrics.success).toBe(true);
    expect(result.diff).toContain("guarded");
    expect(result.metrics.totalTokens).toBe(12);
    expect(result.metrics.criteriaPassed).toEqual(task.acceptanceCriteria);
    // Result id must be a safe single path segment (no raw slash from model).
    expect(result.id).not.toContain("/");
    expect(result.id).toContain("anthropic_claude-opus-4.8");
  });

  it("marks failure and skips tests when the agent process errors", async () => {
    const runner = new FakeRunner("echo boom >&2; exit 3");
    const result = await runner.runTask(task, config);
    expect(result.metrics.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.metrics.criteriaFailed).toEqual(task.acceptanceCriteria);
  });

  it("marks failure when verification commands fail", async () => {
    const failingTask: Task = { ...task, testCommands: ["false"] };
    const runner = new FakeRunner(
      "printf 'x\\n' >> src/api/users.ts; echo '{\"type\":\"result\"}'",
    );
    const result = await runner.runTask(failingTask, config);
    expect(result.metrics.success).toBe(false);
  });

  it("treats a task with no test commands as passing on a clean run", async () => {
    const noTestTask: Task = { ...task, testCommands: [] };
    const runner = new FakeRunner("echo '{\"type\":\"result\"}'");
    const result = await runner.runTask(noTestTask, config);
    expect(result.metrics.success).toBe(true);
  });
});
