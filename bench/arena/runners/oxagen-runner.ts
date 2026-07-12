/**
 * Oxagen Agent Runner
 *
 * Executes benchmark tasks using the Oxagen CLI one-shot mode:
 *   oxagen --local --output-format json --model <slug> [--budget N] -- <prompt>
 */

import type { AgentConfig, Metrics } from "../src/lib/types.js";
import { BaseAgentRunner } from "./agent-runner.js";
import { countOf, num, parseJsonEnvelope } from "./lib.js";

/** Oxagen speaks gateway slugs (e.g. `anthropic/claude-opus-4.8`) directly. */
export function resolveOxagenModel(model: string): string {
  return model;
}

/** Build the one-shot argv. Options first, then `--` so the prompt is never
 * mistaken for a flag. */
export function buildOxagenArgs(
  prompt: string,
  model: string,
  config: AgentConfig,
): string[] {
  const args = ["--local", "--output-format", "json", "--model", model];
  if (config.budget) args.push("--budget", String(config.budget));
  const maxSteps = config.config?.maxIterations;
  if (typeof maxSteps === "number") args.push("--max-steps", String(maxSteps));
  args.push("--", prompt);
  return args;
}

/** Parse the one-shot result envelope:
 * `{ type:"result", usage:{inputTokens,outputTokens,totalTokens}, steps,
 *    filesTouched:[], commandsRun:[], ... }`. The envelope carries no cost, so
 * cost is derived from the token counts and the model's rate card. */
export function parseOxagenMetrics(
  stdout: string,
  startTime: number,
  config: AgentConfig,
  calcCost: (input: number, output: number, model: string) => number,
): Partial<Metrics> {
  const env = parseJsonEnvelope(stdout);
  const durationSeconds = (Date.now() - startTime) / 1000;
  if (!env) return { durationSeconds };

  const usage = (env.usage ?? {}) as Record<string, unknown>;
  const details = (usage.inputTokenDetails ?? {}) as Record<string, unknown>;
  const inputTokens = num(usage.inputTokens);
  const outputTokens = num(usage.outputTokens);

  return {
    totalTokens: num(usage.totalTokens, inputTokens + outputTokens),
    inputTokens,
    outputTokens,
    cacheReadTokens: num(usage.cachedInputTokens ?? details.cacheReadTokens),
    totalCost: calcCost(inputTokens, outputTokens, config.model),
    toolCalls: countOf(env.commandsRun),
    filesTouched: countOf(env.filesTouched),
    iterations: num(env.steps, 1),
    durationSeconds,
  };
}

export class OxagenRunner extends BaseAgentRunner {
  agentType = "oxagen" as const;

  private oxagenPath = process.env.OXAGEN_BIN ?? "oxagen";

  protected binary(): string {
    return this.oxagenPath;
  }

  protected resolveModel(model: string): string {
    return resolveOxagenModel(model);
  }

  protected buildArgs(
    prompt: string,
    model: string,
    config: AgentConfig,
  ): string[] {
    return buildOxagenArgs(prompt, model, config);
  }

  protected envFor(config: AgentConfig): Record<string, string> {
    return {
      AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY ?? "",
      OXAGEN_MODEL_SLUG: config.model,
      OXAGEN_BUDGET: String(config.budget ?? 25),
    };
  }

  protected parseMetrics(
    stdout: string,
    startTime: number,
    config: AgentConfig,
  ): Partial<Metrics> {
    return parseOxagenMetrics(stdout, startTime, config, (i, o, m) =>
      this.calculateCost(i, o, m),
    );
  }
}
