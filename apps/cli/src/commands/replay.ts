/**
 * `oxagen replay` — inspect how a past turn was handled, outside the REPL.
 *
 * Prints the full trace for a turn: the original prompt, its completeness/
 * complexity scores, the context the enhancer injected, the model that was
 * selected and why, and the advisor's completeness verdict(s) with reasoning.
 * With no argument it shows the most recent turn; `--list` shows recent turns to
 * choose from; an index (`oxagen replay 2`) or id picks a specific one.
 */
import { openTraceStore } from "../agent/trace-store.js";
import { formatTraceText, formatTraceList } from "../agent/trace-format.js";

export interface ReplayOptions {
  list?: boolean;
}

export async function handleReplay(
  arg: string | undefined,
  options: ReplayOptions = {},
): Promise<void> {
  const store = openTraceStore(process.cwd());

  if (options.list) {
    process.stdout.write(formatTraceList(store.list()) + "\n");
    return;
  }

  const trace = store.resolve(arg ?? "");
  if (!trace) {
    process.stderr.write(
      arg
        ? `No turn matches "${arg}". Run \`oxagen replay --list\` to see recent turns.\n`
        : "No turns recorded yet. Run a prompt first.\n",
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(formatTraceText(trace) + "\n");
}
