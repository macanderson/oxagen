/**
 * Claude Code Agent Runner
 *
 * Executes benchmark tasks using the Claude Code CLI in print mode:
 *   claude -p --output-format json --model <alias> --permission-mode acceptEdits
 *          [--max-budget-usd N] <prompt>
 */

import type { AgentConfig, Metrics } from "../src/lib/types.js";
import { BaseAgentRunner } from "./agent-runner.js";
import { countOf, num, parseJsonEnvelope } from "./lib.js";

/** The Claude CLI `--model` takes an alias (`opus`/`sonnet`/`haiku`/`fable`) or
 * a full model name. Arena slugs like `anthropic/claude-opus-4.8` map to the
 * family alias; unrecognized slugs pass through. */
export function resolveClaudeModel(model: string): string {
  const bare = model.replace(/^anthropic\//, "");
  const family = bare.match(/^claude-(opus|sonnet|haiku|fable)/)?.[1];
  return family ?? bare;
}

/** Build print-mode argv. The prompt is the trailing positional. */
export function buildClaudeArgs(
  prompt: string,
  model: string,
  config: AgentConfig,
): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--permission-mode",
    "acceptEdits",
  ];
  if (config.budget) args.push("--max-budget-usd", String(config.budget));
  args.push(prompt);
  return args;
}

/** Parse Claude Code's `--output-format json` result envelope:
 * `{ type:"result", total_cost_usd, num_turns, duration_ms,
 *    usage:{ input_tokens, output_tokens, cache_read_input_tokens } }`. */
export function parseClaudeMetrics(
  stdout: string,
  startTime: number,
): Partial<Metrics> {
  const env = parseJsonEnvelope(stdout);
  const durationSeconds = (Date.now() - startTime) / 1000;
  if (!env) return { durationSeconds };

  const usage = (env.usage ?? {}) as Record<string, unknown>;
  const inputTokens = num(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = num(usage.output_tokens ?? usage.outputTokens);

  return {
    totalTokens: num(usage.total_tokens, inputTokens + outputTokens),
    inputTokens,
    outputTokens,
    cacheReadTokens: num(
      usage.cache_read_input_tokens ?? usage.cacheReadTokens,
    ),
    totalCost: num(env.total_cost_usd ?? env.cost_usd),
    toolCalls: countOf(env.tool_calls),
    filesTouched: countOf(env.files_touched),
    iterations: num(env.num_turns, 1),
    durationSeconds,
  };
}

export class ClaudeCodeRunner extends BaseAgentRunner {
  agentType = "claude-code" as const;

  private claudePath = process.env.CLAUDE_BIN ?? "claude";

  protected binary(): string {
    return this.claudePath;
  }

  protected resolveModel(model: string): string {
    return resolveClaudeModel(model);
  }

  protected buildArgs(
    prompt: string,
    model: string,
    config: AgentConfig,
  ): string[] {
    return buildClaudeArgs(prompt, model, config);
  }

  protected envFor(): Record<string, string> {
    return {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
    };
  }

  protected parseMetrics(stdout: string, startTime: number): Partial<Metrics> {
    return parseClaudeMetrics(stdout, startTime);
  }
}
