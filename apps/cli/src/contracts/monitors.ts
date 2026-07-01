/**
 * Background-monitor contract (pipeline Group 5 — not yet built).
 *
 * Background monitor subagents watch a long-running external target (a GitHub
 * Actions run, a pull request, a CI job) and never block the main turn: dispatch
 * returns immediately, and the coordinator is notified only on a terminal state
 * (success or failure).
 *
 * This is a fresh, standalone stub: Group 5 has not landed in this worktree.
 * Kept independent of `src/monitors` (which does not exist here) — Group 5
 * implements against this file when it lands. Matches the original
 * `contracts/monitors.ts` stub as-is; nothing here disagreed with shipped code
 * because nothing has shipped yet.
 */
export type MonitorTargetType = "gh_actions_run" | "pull_request" | "ci_job";

export interface MonitorDispatchInput {
  targetType: MonitorTargetType;
  targetId: string;
  /** So the monitor can judge whether a fix applies. */
  committedChangeRefs?: string[];
  pollIntervalSeconds?: number;
}

export interface MonitorDispatchResult {
  subagentId: string;
  /** Always background; returns control immediately. */
  background: true;
}

/** Sent to the coordinator on the terminal state only (fail or success). */
export interface MonitorReport {
  targetId: string;
  status: "succeeded" | "failed";
  identifiedProblem?: boolean;
  canFixWithCommittedChanges?: boolean;
  note?: string;
}

export interface MonitorService {
  /** Dispatches a background subagent and returns without blocking. */
  dispatch(input: MonitorDispatchInput): Promise<MonitorDispatchResult>;
  /** Coordinator registers a handler that surfaces reports to the developer. */
  onReport(handler: (report: MonitorReport) => void): void;
}
