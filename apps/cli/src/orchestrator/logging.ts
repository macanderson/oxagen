/**
 * Orchestrator debug logging (deliverable 5).
 *
 * Every routing decision and every worker dispatch is logged. The formats match
 * `routing-policy.json -> logging` exactly so the lines are greppable and stable:
 *
 *   [route]    complexity=<c> prompt_tokens=<n> selected=<model> coordinator=<bool> reason="<...>"
 *   [route]    complexity=<c> selected=coordinator reason="trivial, no dispatch"   (kept-trivial)
 *   [dispatch] worker=<model> task="<...>" est_tokens=<n>
 *
 * The default sink writes a structured entry to the CLI's `OXAGEN_CLI_DEBUG`
 * JSONL stream (`~/.oxagen/logs/cli.output`, read by `oxagen logs`) with the
 * formatted line carried under `line` so both machine and human readers work.
 * The sink is injectable so tests can capture entries without touching disk.
 */
import { debugLog } from "../lib/debug-log.js";
import type { Complexity } from "./types.js";

/** A routing-decision log entry. */
export interface RouteLogEntry {
  kind: "route";
  complexity: Complexity;
  promptTokens: number;
  selected: string;
  coordinator: boolean;
  reason: string;
}

/** A worker-dispatch log entry. */
export interface DispatchLogEntry {
  kind: "dispatch";
  worker: string;
  task: string;
  estTokens: number;
}

/** Any orchestrator log entry. */
export type OrchestratorLogEntry = RouteLogEntry | DispatchLogEntry;

/** A log sink. The default writes to the debug stream; tests inject a capture. */
export type LogSink = (entry: OrchestratorLogEntry) => void;

/** Truncate a task string for a single log line. */
function short(task: string, max = 120): string {
  const oneLine = task.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Format an entry into its `routing-policy.json` line. */
export function formatLogLine(entry: OrchestratorLogEntry): string {
  if (entry.kind === "dispatch") {
    return `[dispatch] worker=${entry.worker} task="${short(entry.task)}" est_tokens=${entry.estTokens}`;
  }
  if (entry.coordinator) {
    // Kept-trivial template — no prompt_tokens, coordinator is implied.
    return `[route] complexity=${entry.complexity} selected=coordinator reason="${entry.reason}"`;
  }
  return (
    `[route] complexity=${entry.complexity} prompt_tokens=${entry.promptTokens} ` +
    `selected=${entry.selected} coordinator=${entry.coordinator} reason="${entry.reason}"`
  );
}

/**
 * The default sink: emit to the `OXAGEN_CLI_DEBUG` JSONL stream under the "turn"
 * category. Fire-and-forget — a logging failure never breaks routing.
 */
export const defaultLogSink: LogSink = (entry) => {
  void debugLog("turn", `orchestrator.${entry.kind}`, {
    ...entry,
    line: formatLogLine(entry),
  });
};
