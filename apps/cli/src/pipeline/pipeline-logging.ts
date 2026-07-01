/**
 * The single debug-log stream for the pipeline (Group 6, deliverable 4).
 *
 * One stream covers the whole flow. The router (`orchestrator/logging.ts`), the
 * assist tools (`pipeline/logging.ts`), and the monitors (`monitors/logging.ts`)
 * already emit their `[route]` / `[dispatch]` / `[pipeline] tool=…` / `[monitor]`
 * lines into the `OXAGEN_CLI_DEBUG` JSONL stream. This module adds the lines only
 * the pipeline state machine can emit — the `[graph]` context line and the
 * per-step markers (including plan and verify) — in the exact formats from
 * `pipeline-config.json -> logging.examples`:
 *
 *   [graph] query="failing job fix" returned_files=4 coverage=0.88 source=graphrag
 *   [pipeline] step=1 tool=prompt-enhancer status=start reason="completeness 0.55 < 0.70"
 *   [pipeline] step=3 tool=plan status=done tasks=3
 *   [pipeline] step=4 verify status=done evidence=[test.log, screenshot.png]
 *   [pipeline] step=5 tool=judge status=done verdict=pass score=0.91
 *
 * The sink is injectable so integration tests capture the stream without disk.
 */
import { debugLog } from "../lib/debug-log.js";

/** A pipeline step number. */
export type PipelineStepNo = 1 | 2 | 3 | 4 | 5;

/** The `[graph]` context line — logged before grep, and again on a fallback. */
export interface GraphLogEntry {
  kind: "graph";
  query: string;
  returnedFiles: number;
  coverage: number;
  /** Where the context came from — the graph, or the logged grep fallback. */
  source: "graphrag" | "grep-fallback";
}

/** A `[pipeline] step=N …` marker for any step, tool, or verify gate. */
export interface StepLogEntry {
  kind: "step";
  step: PipelineStepNo;
  /** The raw label segment, e.g. `tool=prompt-enhancer`, `tool=plan`, or `verify`. */
  label: string;
  status: "start" | "done" | "skipped" | "looped";
  /** Extra `key=value` fields appended verbatim, in order. */
  fields?: [string, string | number][];
}

/** Any pipeline log entry. */
export type PipelineLogEntry = GraphLogEntry | StepLogEntry;

/** A sink for the pipeline stream. Defaults to the debug JSONL stream. */
export type PipelineLogSink = (entry: PipelineLogEntry) => void;

function renderFields(fields: [string, string | number][] | undefined): string {
  if (!fields || fields.length === 0) return "";
  const rendered = fields
    .map(([k, v]) => (typeof v === "string" ? `${k}="${v}"` : `${k}=${v}`))
    .join(" ");
  return ` ${rendered}`;
}

/** Format an entry into its canonical single-stream line. */
export function formatPipelineLine(entry: PipelineLogEntry): string {
  if (entry.kind === "graph") {
    return (
      `[graph] query="${entry.query}" returned_files=${entry.returnedFiles} ` +
      `coverage=${entry.coverage} source=${entry.source}`
    );
  }
  return `[pipeline] step=${entry.step} ${entry.label} status=${entry.status}${renderFields(entry.fields)}`;
}

/** The default sink: emit to the `OXAGEN_CLI_DEBUG` JSONL stream. Fire-and-forget. */
export const defaultPipelineLogSink: PipelineLogSink = (entry) => {
  const event = entry.kind === "graph" ? "pipeline.graph" : `pipeline.step${entry.step}`;
  void debugLog("turn", event, { ...entry, line: formatPipelineLine(entry) });
};
