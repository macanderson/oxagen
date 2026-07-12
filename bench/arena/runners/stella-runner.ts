/**
 * Stella Agent Runner
 *
 * Executes benchmark tasks using the Stella CLI one-shot mode:
 *   stella run <prompt>
 * with model/output/budget supplied via STELLA_* env vars (avoids clap
 * global-option ordering pitfalls).
 */

import type { AgentConfig, Metrics } from "../src/lib/types.js";
import { BaseAgentRunner } from "./agent-runner.js";
import { countOf, num, parseJsonEnvelope } from "./lib.js";

/** Stella expects `provider/model_id` (e.g. `zai/glm-5.2`). Bare glm ids from
 * the arena presets get the `zai/` provider prefix; anything already scoped is
 * passed through. */
export function resolveStellaModel(model: string): string {
  if (model.includes("/")) return model;
  return `zai/${model}`;
}

/** Stella's one-shot subcommand takes the prompt as its only positional arg. */
export function buildStellaArgs(prompt: string): string[] {
  return ["run", prompt];
}

/** Parse Stella's headless JSON summary. Stella mirrors the Oxagen envelope
 * family but field names may drift, so read both camelCase and snake_case. */
export function parseStellaMetrics(
  stdout: string,
  startTime: number,
): Partial<Metrics> {
  const env = parseJsonEnvelope(stdout);
  const durationSeconds = (Date.now() - startTime) / 1000;
  if (!env) return { durationSeconds };

  const usage = (env.usage ?? env) as Record<string, unknown>;
  const inputTokens = num(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = num(usage.outputTokens ?? usage.output_tokens);

  return {
    totalTokens: num(
      usage.totalTokens ?? usage.total_tokens,
      inputTokens + outputTokens,
    ),
    inputTokens,
    outputTokens,
    cacheReadTokens: num(
      usage.cacheReadTokens ?? usage.cache_read_tokens,
    ),
    totalCost: num(env.costUsd ?? env.cost_usd ?? usage.costUsd ?? usage.cost_usd),
    toolCalls: countOf(env.toolCalls ?? env.commandsRun),
    filesTouched: countOf(env.filesTouched ?? env.files_touched),
    iterations: num(env.steps ?? env.iterations, 1),
    durationSeconds,
  };
}

export class StellaRunner extends BaseAgentRunner {
  agentType = "stella" as const;

  private stellaPath = process.env.STELLA_BIN ?? "stella";

  protected binary(): string {
    return this.stellaPath;
  }

  protected resolveModel(model: string): string {
    return resolveStellaModel(model);
  }

  protected buildArgs(prompt: string): string[] {
    return buildStellaArgs(prompt);
  }

  protected envFor(config: AgentConfig): Record<string, string> {
    const env: Record<string, string> = {
      ZAI_API_KEY: process.env.ZAI_API_KEY ?? "",
      STELLA_BASE_URL:
        process.env.STELLA_BASE_URL ?? "https://api.z.ai/api/coding/paas/v4",
      STELLA_MODEL: this.resolveModel(config.model),
      STELLA_OUTPUT_FORMAT: "json",
    };
    if (config.budget) env.STELLA_BUDGET = String(config.budget);
    return env;
  }

  protected parseMetrics(stdout: string, startTime: number): Partial<Metrics> {
    return parseStellaMetrics(stdout, startTime);
  }
}
