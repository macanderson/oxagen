/**
 * Background-monitor contracts (pipeline Group 5 — agent to agent).
 *
 * A background monitor is a subagent with its own lifecycle: it polls a
 * long-running target (a GitHub Actions run, a pull request's checks, or a CI
 * job) out of process and reports back to the coordinator only on the terminal
 * state (success or failure), never on every poll. Dispatching one MUST NOT
 * block the coordinator's turn — {@link MonitorService.dispatch} always
 * resolves immediately with a `background: true` acknowledgement; the poll
 * loop runs independently and reports later through {@link MonitorService.onReport}.
 *
 * These shapes mirror `monitor-tools.json` (`monitor_dispatch`) exactly, and
 * are re-declared here — rather than imported from a `contracts` package that
 * has not landed yet — so Group 5 is self-contained and type-checks on its own.
 * `MonitorDispatchInput`/`MonitorDispatchResult` are already declared in
 * `../orchestrator/types.ts` (Group 2's collaborator seam); this module's
 * versions are structurally identical so a {@link BackgroundMonitorService}
 * is assignable wherever `orchestrator/types.ts`'s `MonitorService` is expected.
 */

/** The kind of long-running target a monitor watches. */
export type MonitorTargetType = "gh_actions_run" | "pull_request" | "ci_job";

/** Input to `monitor_dispatch`. Matches `monitor-tools.json -> tools[0].input`. */
export interface MonitorDispatchInput {
  targetType: MonitorTargetType;
  targetId: string;
  /** Commits already made, so the monitor can judge whether they fix a failure. */
  committedChangeRefs?: string[];
  /** Poll cadence override; defaults to {@link getPollIntervalSeconds}. */
  pollIntervalSeconds?: number;
}

/**
 * Output of `monitor_dispatch`. Always `background: true` — the coordinator
 * gets this back immediately, before the target has reached a terminal state.
 */
export interface MonitorDispatchResult {
  subagentId: string;
  background: true;
}

/**
 * The agent-to-agent report a monitor sends on the target's terminal state
 * only. Matches `monitor-tools.json -> tools[0].report`.
 */
export interface MonitorReport {
  targetId: string;
  status: "succeeded" | "failed";
  /** On failure: whether the monitor identified the root cause. */
  identifiedProblem?: boolean;
  /** On failure: whether changes already committed can fix the identified problem. */
  canFixWithCommittedChanges?: boolean;
  /** Free-form detail surfaced to the developer alongside the report. */
  note?: string;
}

/** A handler the service invokes for every terminal-state report. */
export type MonitorReportHandler = (report: MonitorReport) => void;

/**
 * The monitor service the coordinator depends on (Group 2's collaborator
 * seam). `dispatch` never blocks; reports arrive later via handlers registered
 * with `onReport`.
 */
export interface MonitorService {
  /** Spawns a background poll and returns control immediately. */
  dispatch(input: MonitorDispatchInput): Promise<MonitorDispatchResult>;
  /** Registers a handler invoked once per monitor, on its terminal state only. */
  onReport(handler: MonitorReportHandler): void;
}

/** One terminal-or-not poll result for a target, as observed by a single check. */
export interface TargetPollResult {
  status: "succeeded" | "failed";
  note?: string;
  /** Set on a failing poll: whether the poller could identify the root cause. */
  identifiedProblem?: boolean;
}

/**
 * Polls a single target once and resolves with its status. Injected so tests
 * are deterministic (no real sleeping or network calls) and so a real
 * implementation (shelling out to `gh run watch`, `gh pr checks`, etc.) can be
 * swapped in without touching {@link MonitorService}. A poller that never
 * settles (long-running or endlessly re-polled by the caller) must not block
 * the caller's dispatch — only the internal poll loop awaits it.
 */
export type TargetPoller = (
  target: MonitorDispatchInput,
  signal: AbortSignal,
) => Promise<TargetPollResult>;
