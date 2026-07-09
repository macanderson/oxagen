/**
 * Background monitors (pipeline Group 5 — agent to agent).
 *
 * The coordinator's `monitor_dispatch` tool: watches a long-running target
 * (a GH Actions run, a pull request's checks, or a CI job) out of process and
 * reports back on the terminal state only, never blocking the turn. See
 * `monitor-tools.json` for the exact contract and `types.ts`'s file header for
 * the design rationale.
 *
 * Group 2 (the orchestrator) injects a `MonitorService` implementation —
 * {@link BackgroundMonitorService} — as its `monitors` collaborator. Group 6
 * wires the dispatch triggers (`shouldDispatchForPullRequest`/`shouldDispatchForCiFix`),
 * the ask-first prompt (`getAskBeforeMonitoring`), and the default surfacer
 * ({@link surfaceReport}) into the 5-step pipeline.
 */
export type {
  MonitorTargetType,
  MonitorDispatchInput,
  MonitorDispatchResult,
  MonitorReport,
  MonitorReportHandler,
  MonitorService,
  TargetPollResult,
  TargetPoller,
} from "./types.js";
export {
  DEFAULT_MONITORS_CONFIG,
  ASK_ENV,
  ON_PR_ENV,
  ON_CI_FIX_ENV,
  POLL_SECONDS_ENV,
  getAskBeforeMonitoring,
  getDispatchOnPullRequest,
  getDispatchOnCiFix,
  getPollIntervalSeconds,
  shouldDispatchForPullRequest,
  shouldDispatchForCiFix,
  type MonitorsConfig,
  type MonitorsConfigPatch,
} from "./config.js";
export {
  formatLogLine,
  defaultLogSink,
  type LogSink,
  type MonitorLogEntry,
  type MonitorDispatchLogEntry,
  type MonitorReportLogEntry,
} from "./logging.js";
export { BackgroundMonitorService, type MonitorServiceDeps } from "./monitor-service.js";
export { createGhTargetPoller, type DefaultPollerDeps, type Exec } from "./default-poller.js";
export { surfaceReport } from "./surface.js";
