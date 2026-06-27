/**
 * Shared domain types for the agent fleet — task planning, the subagent army,
 * and the agents screen.
 *
 * A *plan* decomposes a goal into *tasks*. A task is assigned to a subagent,
 * which runs the local coding loop ({@link runAgent}) against the working tree.
 * The fleet orchestrates many of these at once under a concurrency cap, records
 * what each one built/fixed as memory, and feeds the agents screen its live
 * roster.
 *
 * These types are deliberately framework-free (no Ink, no AI SDK) so the engine
 * and its tests never import a renderer or hit the gateway.
 */

/** Cost/capability tier. Maps to a concrete gateway model via the model router. */
export type ModelTier = "fast" | "balanced" | "precise";

/** Lifecycle of a single planned task. */
export type TaskStatus =
  | "queued" // accepted, waiting for a free agent slot / its dependencies
  | "blocked" // a dependency failed, so this can never run
  | "running" // an agent is actively working on it
  | "done" // completed successfully
  | "failed" // the agent errored or the gateway rejected the call
  | "cancelled"; // the user aborted it before/while running

/** Token + cost accounting for one task or the whole fleet. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** Estimated provider cost in USD, from the vendored rate card. */
  costUsd: number;
}

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

/** A unit of work the fleet can assign to one subagent. */
export interface Task {
  id: string;
  title: string;
  /** The full instruction handed to the subagent (already prompt-enhanced). */
  description: string;
  status: TaskStatus;
  /** Task ids that must reach `done` before this one may start. */
  dependsOn: string[];
  /**
   * Files this task is expected to touch (relative paths). Used to serialize
   * tasks with overlapping file ownership so two agents never fight over a file.
   */
  files: string[];
  /** Tier the planner/router chose for this task. */
  tier: ModelTier;
  /** Concrete gateway model slug resolved from the tier. */
  model: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Short summary the agent produced on completion. */
  summary?: string;
  /** Clean error message when `status === "failed"`. */
  error?: string;
  usage: UsageTotals;
}

/** A decomposed goal: an ordered set of tasks the fleet can execute. */
export interface Plan {
  id: string;
  goal: string;
  createdAt: number;
  tasks: Task[];
  status: "draft" | "executing" | "completed" | "failed";
}

/** A weighted lesson recorded as the fleet builds/fixes code. */
export interface MemoryRecord {
  id: string;
  createdAt: number;
  /** What kind of lesson this is — mirrors the platform `agent.memory.write` kinds. */
  kind:
    | "routine-change"
    | "constraint"
    | "bug-root-cause"
    | "convention-deviation"
    | "gotcha";
  /** How much it should influence future work. */
  weight: "low" | "high" | "critical";
  /** The lesson itself, in one or two sentences. */
  lesson: string;
  /** Files the lesson is about (used for lexical recall scoring). */
  files: string[];
  /** Task that produced it, if any. */
  taskId?: string;
  outcome: "success" | "failure";
}

/** Live, render-friendly snapshot of one working subagent. */
export interface AgentSnapshot {
  taskId: string;
  title: string;
  tier: ModelTier;
  model: string;
  status: TaskStatus;
  /** Tool-loop steps taken so far. */
  steps: number;
  /** Last tool the agent invoked, for the activity column. */
  lastTool?: string;
  usage: UsageTotals;
  startedAt?: number;
  finishedAt?: number;
  /** Tail of the agent's streamed reasoning/output, for the detail view. */
  logTail: string;
  error?: string;
}

/** Whole-fleet snapshot the agents screen renders each tick. */
export interface FleetSnapshot {
  agents: AgentSnapshot[];
  queuedCount: number;
  runningCount: number;
  doneCount: number;
  failedCount: number;
  totals: UsageTotals;
  concurrency: number;
}
