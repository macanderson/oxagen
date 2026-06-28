/**
 * Shared domain types for the agent fleet — task planning, the subagent army,
 * and the agents screen.
 *
 * A *plan* decomposes a goal into *tasks*. A task is assigned to a subagent,
 * which runs the coding loop against the working tree. The fleet orchestrates
 * many of these at once under a concurrency cap, records what each one
 * built/fixed as memory, and feeds the agents screen its live roster.
 *
 * These types are deliberately framework-free (no Ink, no AI SDK) so the engine
 * and its tests never import a renderer or hit the gateway.
 */
import type { ModelTier, UsageTotals } from "../types";

// Re-export for consumers that import fleet types directly.
export type { ModelTier, UsageTotals };

/** Lifecycle of a single planned task. */
export type TaskStatus =
  | "queued" // accepted, waiting for a free agent slot / its dependencies
  | "blocked" // a dependency failed, so this can never run
  | "running" // an agent is actively working on it
  | "done" // completed successfully
  | "failed" // the agent errored or the gateway rejected the call
  | "cancelled"; // the user aborted it before/while running

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
  /** Named agent definition the planner assigned this task to (if any). */
  agent?: string;
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

/** A named agent persona the planner may assign tasks to. */
export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  /** Tool allowlist in permission syntax. `undefined` means all tools. */
  tools?: string[];
  model?: string;
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
