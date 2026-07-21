/**
 * `oxagen logs` — see and debug the CLI's `.output` log.
 *
 * The CLI writes a JSONL debug stream to `~/.oxagen/logs/cli.output` when
 * `OXAGEN_CLI_DEBUG=1`. This command surfaces it: print the path, tail recent
 * entries (optionally filtered by category), follow it live, or clear it. It is
 * the "give me a way to see and debug the CLI log files" surface.
 */
import { watch } from "node:fs";
import {
  DEBUG_ENV,
  debugLogFile,
  isDebugEnabled,
  readDebugLog,
  clearDebugLog,
  type DebugCategory,
  type DebugLogEntry,
} from "../lib/debug-log.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

export interface LogsOptions {
  /** Print only the log file path and exit. */
  path?: boolean;
  /** Number of recent entries to show (default 50). */
  lines?: string;
  /** Only show entries in this category (e.g. code-graph, llm, api). */
  category?: string;
  /** Follow the log live (like `tail -f`). */
  follow?: boolean;
  /** Truncate the log to empty and exit. */
  clear?: boolean;
  /** Emit raw JSONL instead of the formatted view. */
  json?: boolean;
}

/** Format one entry as a compact, greppable line. */
function formatEntry(entry: DebugLogEntry): string {
  const head = `${entry.ts}  ${entry.category.padEnd(11)} ${entry.event}`;
  if (entry.data === undefined) return head;
  let detail: string;
  try {
    detail = JSON.stringify(entry.data);
  } catch {
    detail = String(entry.data);
  }
  // Keep the tail readable; the full payload is always in the raw file / --json.
  if (detail.length > 400) detail = `${detail.slice(0, 400)}…`;
  return `${head}  ${detail}`;
}

function matchesCategory(entry: DebugLogEntry, category?: string): boolean {
  return !category || entry.category === (category as DebugCategory);
}

export async function handleLogs(
  opts: LogsOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const file = debugLogFile();

  if (opts.path) {
    writer.write(file);
    return;
  }

  if (opts.clear) {
    await clearDebugLog();
    writer.write(`Cleared ${file}`);
    return;
  }

  if (!isDebugEnabled()) {
    writer.writeErr(
      `Debug logging is off. Enable it with ${DEBUG_ENV}=1 (export it, or set it ` +
        `in settings.json "env"), then re-run the command you want to trace.\n` +
        `Log file: ${file}`,
    );
    // Still show whatever was captured on a previous run, if anything.
  }

  const limit = Math.max(1, Number.parseInt(opts.lines ?? "50", 10) || 50);
  const entries = (await readDebugLog(limit * 4)).filter((e) =>
    matchesCategory(e, opts.category),
  );
  const shown = entries.slice(-limit);

  if (opts.json) {
    for (const e of shown) writer.write(JSON.stringify(e));
  } else if (shown.length === 0) {
    writer.write(`No log entries yet at ${file}`);
  } else {
    for (const e of shown) writer.write(formatEntry(e));
  }

  // Follow mode redraws the terminal live (tail -f) — only meaningful against
  // a real TTY. The REPL's inline capture-execution seam never passes
  // --follow through (see repl/cli-bridge.ts); guard here too so a stray
  // capture-mode call can't block forever on a `watch()` no one can Ctrl-C.
  if (!opts.follow || writer !== stdoutWriter) return;

  // Follow mode: re-read on every change to the file and print anything new.
  // Cheap and correct for an append-only JSONL log at CLI cadence.
  process.stderr.write(`\nFollowing ${file} (Ctrl-C to stop)…\n`);
  let seen = (await readDebugLog(Number.MAX_SAFE_INTEGER)).length;
  await new Promise<void>((resolve) => {
    let watcher: ReturnType<typeof watch> | null = null;
    try {
      watcher = watch(file, { persistent: true }, () => {
        void (async () => {
          const all = await readDebugLog(Number.MAX_SAFE_INTEGER);
          const fresh = all
            .slice(seen)
            .filter((e) => matchesCategory(e, opts.category));
          seen = all.length;
          for (const e of fresh) {
            process.stdout.write(
              `${opts.json ? JSON.stringify(e) : formatEntry(e)}\n`,
            );
          }
        })();
      });
    } catch (err) {
      process.stderr.write(
        `Cannot follow ${file}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      resolve();
      return;
    }
    const stop = (): void => {
      watcher?.close();
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
