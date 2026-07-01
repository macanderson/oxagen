/**
 * Assist-tool debug logging (pipeline Group 4).
 *
 * Every assist tool must be *visible*: the developer should see the prompt
 * enhancer, the judge, and the survey fire — including when they are skipped — in
 * the debug output. Each call emits a single canonical `[pipeline]` line into the
 * `OXAGEN_CLI_DEBUG` stream (`~/.oxagen/logs/cli.output`), greppable as:
 *
 *   [pipeline] step=1 tool=prompt-enhancer status=start reason="completeness 0.5 < 0.7"
 *   [pipeline] step=1 tool=prompt-enhancer status=done result=enhanced complexity=medium …
 *   [pipeline] step=5 tool=judge        status=skipped reason="pipeline off"
 *
 * The line is stored as the log entry's `event`, and the structured fields are
 * kept on `data` so `oxagen logs` / `jq` can filter without re-parsing the text.
 * Logging is best-effort and never throws — a logging failure must not break a
 * turn (see {@link debugLog}).
 */
import { debugLog } from "../lib/debug-log.js";
import type { ToolName, ToolStatus } from "./types.js";

export interface ToolEvent {
  tool: ToolName;
  /** Pipeline step this tool belongs to (enhancer/survey = 1, judge = 5). */
  step: number;
  status: ToolStatus;
}

/** An ordered `key=value` field appended to the canonical line. */
export type LogField = [key: string, value: string | number | undefined];

/** Quote a value only when it contains whitespace or a quote, matching the spec. */
function quote(value: string | number): string {
  const s = String(value);
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/**
 * Render the canonical single-line record. Fields are emitted in the order given
 * (the assist-tools contract fixes the order per tool/status); `undefined` and
 * empty-string fields are dropped so a skip line stays terse.
 */
export function formatToolLine(ev: ToolEvent, fields: LogField[] = []): string {
  const parts = ["[pipeline]", `step=${ev.step}`, `tool=${ev.tool}`, `status=${ev.status}`];
  for (const [key, value] of fields) {
    if (value === undefined || value === "") continue;
    parts.push(`${key}=${quote(value)}`);
  }
  return parts.join(" ");
}

/**
 * Emit one assist-tool event to the debug stream. Returns the exact line written
 * so callers/tests can assert on it. No-op body when `OXAGEN_CLI_DEBUG` is off,
 * but the formatted line is always returned.
 */
export async function logTool(ev: ToolEvent, fields: LogField[] = []): Promise<string> {
  const line = formatToolLine(ev, fields);
  const structured: Record<string, unknown> = { step: ev.step, tool: ev.tool, status: ev.status };
  for (const [key, value] of fields) {
    if (value !== undefined && value !== "") structured[key] = value;
  }
  await debugLog("pipeline", line, structured);
  return line;
}
