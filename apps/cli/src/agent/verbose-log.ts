/**
 * Verbose structured-log stream.
 *
 * When a session runs in `/verbose` mode, every turn's full {@link TurnTrace} is
 * appended — one JSON object per line (JSONL) — to a per-project log under
 * `~/.config/oxagen/verbose/<project>.jsonl`. Unlike the trace *store* (which is
 * capped at the latest 100 turns for `/replay`), this stream is append-only and
 * complete: it is the machine-readable record you analyze to prove the agent is
 * fast, cheap, and self-improving — feed it to `jq`, a notebook, or a dashboard.
 *
 * Writes are best-effort: a failed log write must never break a turn.
 */
import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { TurnTrace } from "./trace.js";

function projectKey(cwd: string): string {
  return basename(cwd) || "default";
}

/** Path of the JSONL verbose log for a working directory. */
export function verboseLogPath(cwd: string): string {
  return join(
    homedir(),
    ".config",
    "oxagen",
    "verbose",
    `${projectKey(cwd)}.jsonl`,
  );
}

/** Append one turn's trace to the verbose JSONL stream. Best-effort. */
export function appendVerboseLog(cwd: string, trace: TurnTrace): void {
  const path = verboseLogPath(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(trace) + "\n", "utf8");
  } catch (err) {
    // Logging is best-effort — never break a turn over it — but surface the
    // cause under OXAGEN_DEBUG so a silently-missing verbose record can be
    // diagnosed rather than leaving an unexplained gap in the JSONL stream.
    if (process.env["OXAGEN_DEBUG"])
      process.stderr.write(
        `[verbose-log] append failed (${path}): ${err instanceof Error ? err.message : String(err)}\n`,
      );
  }
}

/** Read every record from the verbose JSONL stream (skipping malformed lines). */
export function readVerboseLog(cwd: string): TurnTrace[] {
  const path = verboseLogPath(cwd);
  if (!existsSync(path)) return [];
  const out: TurnTrace[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as TurnTrace);
    } catch {
      /* skip a corrupt/partial line rather than failing the whole read */
    }
  }
  return out;
}
