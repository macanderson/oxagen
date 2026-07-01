/**
 * Background-monitor debug logging (pipeline Group 5).
 *
 * Every dispatch and every terminal-state report is logged. The formats match
 * `monitor-tools.json -> tools[0].logging` exactly so the lines are greppable
 * and stable:
 *
 *   [monitor] target=<type>:<id> status=dispatched background=true
 *   [monitor] target=<type>:<id> status=<succeeded|failed> identified_problem=<bool> can_fix_with_committed_changes=<bool> note="<...>"
 *
 * The default sink writes a structured entry to the CLI's `OXAGEN_CLI_DEBUG`
 * JSONL stream (`~/.oxagen/logs/cli.output`, read by `oxagen logs`) with the
 * formatted line carried under `line` so both machine and human readers work.
 * The sink is injectable so tests can capture entries without touching disk.
 */
import { debugLog } from "../lib/debug-log.js";
import type { MonitorTargetType } from "./types.js";

/** A dispatch log entry — emitted the instant `monitor_dispatch` returns. */
export interface MonitorDispatchLogEntry {
  kind: "dispatch";
  targetType: MonitorTargetType;
  targetId: string;
  /** The dispatched monitor's id, for correlating with its later report. */
  subagentId: string;
  /** ISO timestamp of the dispatch, not part of the formatted line. */
  at: string;
}

/** A terminal-state report log entry — emitted once per monitor, never per poll. */
export interface MonitorReportLogEntry {
  kind: "report";
  targetType: MonitorTargetType;
  targetId: string;
  status: "succeeded" | "failed";
  identifiedProblem: boolean;
  canFixWithCommittedChanges: boolean;
  note: string;
  /** The reporting monitor's id, for correlating with its earlier dispatch. */
  subagentId: string;
  /** ISO timestamp of the report, not part of the formatted line. */
  at: string;
}

/** Any background-monitor log entry. */
export type MonitorLogEntry = MonitorDispatchLogEntry | MonitorReportLogEntry;

/** A log sink. The default writes to the debug stream; tests inject a capture. */
export type LogSink = (entry: MonitorLogEntry) => void;

/** Format an entry into its `monitor-tools.json -> logging` line. */
export function formatLogLine(entry: MonitorLogEntry): string {
  const target = `${entry.targetType}:${entry.targetId}`;
  if (entry.kind === "dispatch") {
    return `[monitor] target=${target} status=dispatched background=true`;
  }
  return (
    `[monitor] target=${target} status=${entry.status} ` +
    `identified_problem=${entry.identifiedProblem} ` +
    `can_fix_with_committed_changes=${entry.canFixWithCommittedChanges} ` +
    `note="${entry.note}"`
  );
}

/**
 * The default sink: emit to the `OXAGEN_CLI_DEBUG` JSONL stream under the
 * "turn" category, matching the orchestrator's own log entries. Fire-and-forget
 * — a logging failure never breaks a dispatch or a report.
 */
export const defaultLogSink: LogSink = (entry) => {
  const event = entry.kind === "dispatch" ? "monitor.dispatch" : "monitor.report";
  void debugLog("turn", event, { ...entry, line: formatLogLine(entry) });
};
