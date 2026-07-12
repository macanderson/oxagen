/**
 * Arena Agent Runner Interface
 *
 * Base interface for running benchmarks against different agentic coding tools.
 */

import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { tmpdir } from "os";

import type { AgentConfig, AgentType, BenchmarkResult, Metrics, Task } from "../src/lib/types.js";
import { buildTaskPrompt, sanitizeSegment } from "./lib.js";

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

/** Outcome of a single agent execution, before base-class defaults are applied. */
export interface ExecuteResult {
  success: boolean;
  output: string;
  diff: string;
  metrics: Partial<Metrics>;
  error?: string;
}

/**
 * Base class for agent runners.
 *
 * The execution flow (seed workspace → spawn the agent → collect the diff →
 * run the task's verification commands → parse metrics) is identical across
 * agents; only the CLI invocation and metric envelope differ. Subclasses
 * implement four small hooks — {@link binary}, {@link resolveModel},
 * {@link buildArgs}, {@link parseMetrics} — and optionally {@link envFor}.
 */
export abstract class BaseAgentRunner implements AgentRunner {
  abstract agentType: AgentType;

  /** Executable name (resolved via PATH by execFileSync). */
  protected abstract binary(): string;

  /** Map the arena's canonical model slug to what this CLI expects. */
  protected abstract resolveModel(model: string): string;

  /** Build the argv passed to the agent binary (no shell — injection-safe). */
  protected abstract buildArgs(
    prompt: string,
    model: string,
    config: AgentConfig,
  ): string[];

  /** Extra environment for the spawned process (merged over process.env). */
  protected envFor(_config: AgentConfig): Record<string, string> {
    return {};
  }

  /** Parse the agent's stdout JSON envelope into metrics. */
  protected abstract parseMetrics(
    stdout: string,
    startTime: number,
    config: AgentConfig,
  ): Partial<Metrics>;

  /** True when the agent binary responds to `--version`. */
  isAvailable(): Promise<boolean> {
    try {
      execFileSync(this.binary(), ["--version"], {
        stdio: "ignore",
        timeout: 5000,
      });
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }

  /** The agent binary's reported `--version`, or "unknown". */
  getVersion(): Promise<string> {
    try {
      return Promise.resolve(
        execFileSync(this.binary(), ["--version"], {
          encoding: "utf-8",
        }).trim(),
      );
    } catch {
      return Promise.resolve("unknown");
    }
  }

  protected executeTask(task: Task, config: AgentConfig): ExecuteResult {
    const workDir = join(tmpdir(), `${this.agentType}-bench-${randomUUID()}`);

    try {
      this.seedWorkspace(workDir, task);

      const prompt = buildTaskPrompt(task);
      const args = this.buildArgs(prompt, this.resolveModel(config.model), config);
      const timeoutMs = (config.timeout ?? 600) * 1000;
      const startTime = Date.now();

      let stdout = "";
      let runError: string | undefined;

      try {
        stdout = execFileSync(this.binary(), args, {
          cwd: workDir,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: timeoutMs,
          encoding: "utf-8",
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, ...this.envFor(config) },
        });
      } catch (error) {
        const e = error as {
          stdout?: string | Buffer;
          stderr?: string | Buffer;
          message?: string;
        };
        stdout = e.stdout ? e.stdout.toString() : "";
        const stderr = e.stderr ? e.stderr.toString().trim() : "";
        runError = [e.message ?? String(error), stderr]
          .filter(Boolean)
          .join("\n");
      }

      const diff = this.collectDiff(workDir);
      const metrics = this.parseMetrics(stdout, startTime, config);

      // A run is a success only if the agent process exited cleanly AND the
      // task's verification commands pass. A crashed/argument-rejected agent is
      // always a failure regardless of any partial diff.
      const testResults = runError
        ? { passed: false, error: runError }
        : this.runTests(task, workDir);

      return {
        success: testResults.passed,
        output: stdout,
        diff,
        metrics: {
          ...metrics,
          diffSize: diff.length,
          criteriaPassed: testResults.passed ? task.acceptanceCriteria : [],
          criteriaFailed: testResults.passed ? [] : task.acceptanceCriteria,
        },
        error: testResults.error,
      };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  /**
   * Materialize a coherent starting workspace: an initialized git repo, a
   * `TASK.md` describing the work, and a stub for each declared target file so
   * the agent has a concrete file to edit. The seed is committed so `git diff
   * HEAD` isolates exactly the agent's changes.
   */
  protected seedWorkspace(workDir: string, task: Task): void {
    mkdirSync(workDir, { recursive: true });
    const git = (args: string[]): void => {
      execFileSync("git", args, { cwd: workDir, stdio: "ignore" });
    };
    git(["init"]);
    git(["config", "user.email", "bench@oxagen.sh"]);
    git(["config", "user.name", "oxagen-bench"]);

    writeFileSync(join(workDir, "TASK.md"), buildTaskPrompt(task) + "\n");
    // Keep the captured diff to the agent's own edits: exclude installed deps
    // and build output an agent may create while solving the task.
    writeFileSync(
      join(workDir, ".gitignore"),
      ["node_modules/", ".vite/", "dist/", "build/", "coverage/", ".next/", "*.log"].join("\n") +
        "\n",
    );

    for (const rel of task.filesToModify ?? []) {
      const abs = join(workDir, rel);
      if (existsSync(abs)) continue;
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `// TODO(${task.id}): ${task.startingPoint}\n`);
    }

    git(["add", "-A"]);
    git(["commit", "-m", "seed: benchmark starting point", "--no-verify"]);
  }

  /** Diff of the agent's changes (tracked + new) against the seed commit. */
  protected collectDiff(workDir: string): string {
    try {
      execFileSync("git", ["add", "-A"], { cwd: workDir, stdio: "ignore" });
      return execFileSync("git", ["diff", "--cached", "HEAD"], {
        cwd: workDir,
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      try {
        return execFileSync("git", ["diff"], {
          cwd: workDir,
          encoding: "utf-8",
          maxBuffer: 64 * 1024 * 1024,
        });
      } catch {
        return "";
      }
    }
  }

  protected runTests(
    task: Task,
    workDir: string,
  ): { passed: boolean; error?: string } {
    if (!task.testCommands || task.testCommands.length === 0) {
      return { passed: true };
    }

    for (const cmd of task.testCommands) {
      try {
        execFileSync("sh", ["-c", cmd], {
          cwd: workDir,
          stdio: "pipe",
          timeout: 60_000,
        });
      } catch (error) {
        return {
          passed: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { passed: true };
  }

  runTask(task: Task, config: AgentConfig): Promise<BenchmarkResult> {
    const startTime = Date.now();

    try {
      const result = this.executeTask(task, config);
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

      return Promise.resolve<BenchmarkResult>({
        id: this.generateResultId(task, config),
        taskId: task.id,
        agent: config,
        metrics,
        provenance: {
          kind: "measured",
          runId: this.generateRunId(),
          runDate: new Date().toISOString(),
          gitSha: this.getGitSha()
        },
        prompt: task.description,
        diff: result.diff,
        output: result.output,
        error: result.error
      });
    } catch (error) {
      const durationSeconds = (Date.now() - startTime) / 1000;

      return Promise.resolve<BenchmarkResult>({
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
          gitSha: this.getGitSha()
        },
        prompt: task.description,
        diff: "",
        output: "",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  protected generateResultId(task: Task, config: AgentConfig): string {
    // Model slugs contain `/` (e.g. anthropic/claude-opus-4.8); sanitize so the
    // id is a safe single filename segment for `results/<run>/<id>.json`.
    return `${task.id}-${config.type}-${sanitizeSegment(config.model)}-${String(Date.now())}`;
  }

  protected generateRunId(): string {
    const rand = Math.random().toString(36).slice(2, 8);
    return `run-${String(Date.now())}-${rand}`;
  }

  protected getGitSha(): string {
    try {
      return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        encoding: "utf-8",
      }).trim();
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

    // Cast through `| undefined`: the tsconfig lacks noUncheckedIndexedAccess,
    // so the index type claims the lookup is always present when it may not be.
    const rate = pricing[model] as { input: number; output: number } | undefined;
    const input = rate?.input ?? 3;
    const output = rate?.output ?? 15;
    return (inputTokens / 1_000_000) * input + (outputTokens / 1_000_000) * output;
  }
}
