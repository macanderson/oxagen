/**
 * Arena Agent Runner Interface
 *
 * Base interface for running benchmarks against different agentic coding tools.
 */

import type { AgentConfig, AgentType, BenchmarkResult, Metrics, Task } from "../src/lib/types.js";

export interface AgentRunner {
  /** Agent type this runner handles */
  agentType: AgentType;

  /** Run a single task and collect metrics */
  runTask(task: Task, config: AgentConfig): Promise<BenchmarkResult>;

  /** Check if the runner is available/ready */
  isAvailable(): Promise<boolean>;

  /** Get the current version of the agent */
  getVersion(): Promise<string>;
}

/**
 * Base class for agent runners with common utilities
 */
export abstract class BaseAgentRunner implements AgentRunner {
  abstract agentType: AgentType;

  protected abstract executeTask(task: Task, config: AgentConfig): Promise<{
    success: boolean;
    output: string;
    diff: string;
    metrics: Partial<Metrics>;
    error?: string;
  }>;

  abstract isAvailable(): Promise<boolean>;
  abstract getVersion(): Promise<string>;

  async runTask(task: Task, config: AgentConfig): Promise<BenchmarkResult> {
    const startTime = Date.now();

    try {
      const result = await this.executeTask(task, config);
      const durationSeconds = (Date.now() - startTime) / 1000;

      // Fill in missing metrics with defaults
      const metrics: Metrics = {
        success: result.success,
        criteriaPassed: result.success ? task.acceptanceCriteria : [],
        criteriaFailed: result.success ? [] : task.acceptanceCriteria,
        durationSeconds,
        totalTokens: result.metrics.totalTokens ?? 0,
        inputTokens: result.metrics.inputTokens ?? 0,
        outputTokens: result.metrics.outputTokens ?? 0,
        cacheReadTokens: result.metrics.cacheReadTokens,
        totalCost: result.metrics.totalCost ?? 0,
        toolCalls: result.metrics.toolCalls ?? 0,
        filesTouched: result.metrics.filesTouched ?? 0,
        linesAdded: result.metrics.linesAdded ?? 0,
        linesRemoved: result.metrics.linesRemoved ?? 0,
        diffSize: result.metrics.diffSize ?? result.diff.length,
        iterations: result.metrics.iterations ?? 1,
        peakMemoryMb: result.metrics.peakMemoryMb
      };

      return {
        id: this.generateResultId(task, config),
        taskId: task.id,
        agent: config,
        metrics,
        provenance: {
          kind: "measured",
          runId: this.generateRunId(),
          runDate: new Date().toISOString(),
          gitSha: await this.getGitSha()
        },
        prompt: task.description,
        diff: result.diff,
        output: result.output,
        error: result.error
      };
    } catch (error) {
      const durationSeconds = (Date.now() - startTime) / 1000;

      return {
        id: this.generateResultId(task, config),
        taskId: task.id,
        agent: config,
        metrics: {
          success: false,
          criteriaPassed: [],
          criteriaFailed: task.acceptanceCriteria,
          durationSeconds,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCalls: 0,
          filesTouched: 0,
          linesAdded: 0,
          linesRemoved: 0,
          diffSize: 0,
          iterations: 0
        },
        provenance: {
          kind: "measured",
          runId: this.generateRunId(),
          runDate: new Date().toISOString(),
          gitSha: await this.getGitSha()
        },
        prompt: task.description,
        diff: "",
        output: "",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  protected generateResultId(task: Task, config: AgentConfig): string {
    return `${task.id}-${config.type}-${config.model}-${Date.now()}`;
  }

  protected generateRunId(): string {
    return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  protected async getGitSha(): Promise<string> {
    try {
      const { execSync } = await import("child_process");
      const sha = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
      return sha;
    } catch {
      return "unknown";
    }
  }

  protected calculateCost(inputTokens: number, outputTokens: number, model: string): number {
    // Claude pricing (approximate, per million tokens)
    const pricing: Record<string, { input: number; output: number }> = {
      "anthropic/claude-haiku-4.5": { input: 0.8, output: 4 },
      "anthropic/claude-sonnet-5": { input: 3, output: 15 },
      "anthropic/claude-opus-4.8": { input: 15, output: 75 }
    };

    const rate = pricing[model] || { input: 3, output: 15 };
    return (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
  }
}
