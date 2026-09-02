/**
 * output.ts — the ONE output discipline for every `oxagen` subcommand.
 *
 * Commands historically hand-rolled their `--json` handling, which drifted
 * into per-command dialects. This layer pins the contract (ADR-023 §4):
 *
 *   - stdout carries ONLY machine/answer content — `data()` results and
 *     `event()` NDJSON lines. Progress, hints, and decoration go to stderr
 *     via `info()`/`warn()`, so `oxagen … --json | jq` never chokes on prose.
 *   - `--json` (or a non-TTY stdout for commands that opt into `autoJson`)
 *     selects machine mode; `--quiet` drops the chrome but never the data.
 *   - Errors are uniform: pretty mode prints `✗ message` to stderr; json mode
 *     prints one `{"type":"error","code","message"}` line to stderr. Both set
 *     the exit code to 1 unless the caller already chose one.
 *
 * Composes with the existing {@link CommandWriter} seam so every command
 * still runs inline inside the REPL (Ink owns the terminal there — nothing
 * may touch process.stdout directly; see lib/capture-writer.ts).
 */
import { stdoutWriter, type CommandWriter } from "./capture-writer.js";

export type OutputMode = "pretty" | "json";

export interface OutputOptions {
  /** `--json`: machine mode. */
  json?: boolean;
  /** `--quiet`: suppress info-level chrome (data and errors always emit). */
  quiet?: boolean;
  /**
   * Streams/pipes select machine mode automatically: when set and stdout is
   * not a TTY, behave as if `--json` was passed. Only streaming commands
   * (watch/logs/dispatch --follow) opt in — a plain list piped to `head`
   * should stay human-readable unless `--json` is explicit.
   */
  autoJson?: boolean;
  /** Injectable for tests; defaults to `process.stdout.isTTY`. */
  stdoutIsTTY?: boolean;
}

export interface Output {
  readonly mode: OutputMode;
  readonly isJson: boolean;
  /**
   * The command's RESULT. json → one `JSON.stringify(value)` line on stdout;
   * pretty → `pretty(value)` when given, else 2-space-indented JSON.
   */
  data(value: unknown, pretty?: (value: unknown) => string): void;
  /** One NDJSON event line on stdout (json mode only; no-op in pretty mode — pretty streams render their own lines). */
  event(event: object): void;
  /** Progress/chrome → stderr. Suppressed by `--quiet`. */
  info(message: string): void;
  /** Warning → stderr. Never suppressed. */
  warn(message: string): void;
  /** Uniform failure line → stderr; sets exit code 1 unless already set. */
  error(err: unknown, code?: string): void;
}

/** Extract a clean one-line message from anything thrown. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

export function createOutput(
  opts: OutputOptions = {},
  writer: CommandWriter = stdoutWriter,
): Output {
  const isTTY = opts.stdoutIsTTY ?? process.stdout.isTTY === true;
  const isJson = opts.json === true || (opts.autoJson === true && !isTTY);
  const quiet = opts.quiet === true;
  return {
    mode: isJson ? "json" : "pretty",
    isJson,
    data: (value, pretty) => {
      if (isJson) writer.write(JSON.stringify(value));
      else
        writer.write(pretty ? pretty(value) : JSON.stringify(value, null, 2));
    },
    event: (event) => {
      if (isJson) writer.write(JSON.stringify(event));
    },
    info: (message) => {
      if (!quiet) writer.writeErr(message);
    },
    warn: (message) => {
      writer.writeErr(message);
    },
    error: (err, code = "error") => {
      const message = errorMessage(err);
      if (isJson)
        writer.writeErr(JSON.stringify({ type: "error", code, message }));
      else writer.writeErr(`✗ ${message}`);
      if (process.exitCode === undefined || process.exitCode === 0)
        process.exitCode = 1;
    },
  };
}
