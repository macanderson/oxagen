/**
 * `oxagen replay` — inspect how a past turn was handled, outside the REPL.
 *
 * Prints the full trace for a turn: the original prompt, its completeness/
 * complexity scores, the context the enhancer injected, the model that was
 * selected and why, and the advisor's completeness verdict(s) with reasoning.
 * With no argument it shows the most recent turn; `--list` shows recent turns to
 * choose from; an index (`oxagen replay 2`) or id picks a specific one.
 *
 * Output discipline (ADR-023 §4): the trace report is the answer and goes to
 * stdout (via the writer, so it is REPL-bridge safe); an unresolved turn is a
 * uniform stderr error line with exit code 1. Output is a human-formatted
 * report (no `--json`) — for a machine-readable execution trace use
 * `oxagen trace <executionId> --json`.
 */
import { openTraceStore } from "../agent/trace-store.js";
import { formatTraceText, formatTraceList } from "../agent/trace-format.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

export interface ReplayOptions {
  list?: boolean;
}

export async function handleReplay(
  arg: string | undefined,
  options: ReplayOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({}, writer);
  const store = openTraceStore(process.cwd());

  if (options.list) {
    const list = store.list();
    out.data(list, () => formatTraceList(list));
    return;
  }

  const trace = store.resolve(arg ?? "");
  if (!trace) {
    out.error(
      arg
        ? `No turn matches "${arg}". Run \`oxagen replay --list\` to see recent turns.`
        : "No turns recorded yet. Run a prompt first.",
      "not_found",
    );
    return;
  }

  out.data(trace, () => formatTraceText(trace));
}
