/**
 * `formatFatalError` — render a top-level (fatal) CLI error for stderr.
 *
 * A raw Node stack trace is noise to someone who just mistyped a path (e.g.
 * `oxagen code diff missing.txt`). By default we surface only `Error: <message>`;
 * the full stack is included solely when debug logging is on (`OXAGEN_CLI_DEBUG`,
 * passed in as `debug`), matching the CLI's debug-gated verbosity elsewhere.
 *
 * Always returns a newline-terminated string so callers can hand it straight to
 * `process.stderr.write` without re-appending a newline.
 */
export function formatFatalError(err: unknown, debug: boolean): string {
  if (err instanceof Error) {
    if (debug && err.stack) return `${err.stack}\n`;
    return `Error: ${err.message}\n`;
  }
  return `Error: ${String(err)}\n`;
}
