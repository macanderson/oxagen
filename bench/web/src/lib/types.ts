/**
 * Shared types for the Oxagen Benchmark Suite.
 *
 * The benchmark is a deterministic *simulation*: each agent has a published
 * performance profile (relative speed, token efficiency, baseline accuracy) and
 * each evaluation has a baseline cost. Given a seed, the engine derives a full
 * set of per-task results reproducibly — no external agents, API keys, or
 * network calls are involved. This lets the dashboard demonstrate comparative
 * analytics offline while staying honest about being a model, not a live race.
 */

export type AgentId = "oxagen-cli" | "claude-code" | "github-copilot" | "google-gemini";

export type Category = "speed" | "efficiency" | "accuracy" | "quality";

export type Difficulty = "easy" | "medium" | "hard";

/** Why a task did not pass — used for failure-mode analysis in the results tab. */
export type FailureMode = "wrong-answer" | "timeout" | "error";

export interface AgentProfile {
  readonly id: AgentId;
  readonly name: string;
  readonly tagline: string;
  /** Wall-clock multiplier vs the Oxagen baseline (1.0). Higher = slower. */
  readonly speedMultiplier: number;
  /** Token efficiency vs baseline (1.0). Lower = uses more tokens. */
  readonly efficiencyMultiplier: number;
  /** Expected pass accuracy on a medium-difficulty task, 0..1. */
  readonly baseAccuracy: number;
  /** Tailwind-friendly hex used for chart bars and chips. */
  readonly color: string;
}

export interface EvalDef {
  readonly id: string;
  readonly name: string;
  readonly category: Category;
  readonly description: string;
  /** Oxagen-baseline wall-clock for this eval at medium difficulty, ms. */
  readonly baseDurationMs: number;
  /** Oxagen-baseline token spend for this eval at medium difficulty. */
  readonly baseTokens: number;
}

export interface TaskResult {
  readonly agentId: AgentId;
  readonly evalId: string;
  readonly durationMs: number;
  readonly tokens: number;
  /** Expected quality of the produced solution, 0..1. */
  readonly accuracy: number;
  readonly passed: boolean;
  readonly failureMode: FailureMode | null;
}

export interface AgentSummary {
  readonly agentId: AgentId;
  readonly avgAccuracy: number;
  readonly passRate: number;
  readonly totalTokens: number;
  readonly avgTokens: number;
  readonly totalDurationMs: number;
  readonly avgDurationMs: number;
  /** Composite 0..100 score used for ranking. */
  readonly score: number;
  /** 1-based rank within the run (1 = best). */
  readonly rank: number;
}

export interface RunConfig {
  readonly agentIds: readonly AgentId[];
  readonly evalIds: readonly string[];
  readonly difficulty: Difficulty;
  readonly seed: number;
}

export interface BenchmarkRun {
  readonly id: string;
  readonly createdAtMs: number;
  readonly difficulty: Difficulty;
  readonly seed: number;
  readonly agentIds: readonly AgentId[];
  readonly evalIds: readonly string[];
  readonly results: readonly TaskResult[];
  readonly summaries: readonly AgentSummary[];
}
