/**
 * Turn-trace persistence — durable storage for the pipeline's per-turn records.
 *
 * Traces live as JSON under `~/.config/oxagen/traces/<project>.json` (one file per
 * project, keyed by the working-directory name, consistent with the fleet store).
 * Persisting them is what makes `/replay` work across turns and even across
 * sessions: the user can always pull up the original prompt, the enhanced prompt,
 * the model that was selected, the advisor that judged it, and the full chain of
 * thought for any recent turn.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { TurnTrace } from "./trace.js";

/** Keep history bounded — the most recent N turns are plenty for replay. */
const MAX_TRACES = 100;

function projectKey(cwd: string): string {
  return basename(cwd) || "default";
}

function storePath(cwd: string): string {
  return join(
    homedir(),
    ".config",
    "oxagen",
    "traces",
    `${projectKey(cwd)}.json`,
  );
}

interface StoreShape {
  traces: TurnTrace[];
}

function read(cwd: string): StoreShape {
  const path = storePath(cwd);
  if (!existsSync(path)) return { traces: [] };
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<StoreShape>;
    return { traces: Array.isArray(parsed.traces) ? parsed.traces : [] };
  } catch {
    return { traces: [] };
  }
}

function write(cwd: string, data: StoreShape): void {
  const path = storePath(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    // Persistence is best-effort — a failed write must never break a turn — but
    // leave a breadcrumb under OXAGEN_DEBUG so a silently-dropped trace (e.g. a
    // full disk or a permissions problem) is diagnosable instead of invisible.
    if (process.env["OXAGEN_DEBUG"])
      process.stderr.write(
        `[trace-store] write failed (${path}): ${err instanceof Error ? err.message : String(err)}\n`,
      );
  }
}

export interface TraceStore {
  /** Persist a trace (newest first), bounding the file to the latest MAX_TRACES. */
  record(trace: TurnTrace): void;
  /** Fetch one trace by id. */
  get(id: string): TurnTrace | undefined;
  /** All traces, newest first. */
  list(): TurnTrace[];
  /** The most recent trace, or undefined if none. */
  last(): TurnTrace | undefined;
  /**
   * Resolve a `/replay` argument to a trace: empty → most recent; a 1-based index
   * (`/replay 2` = second-newest); or an id (exact, then prefix). undefined if no match.
   */
  resolve(arg: string): TurnTrace | undefined;
}

/** Open the trace store for a working directory. */
export function openTraceStore(cwd: string): TraceStore {
  return {
    record(trace) {
      const data = read(cwd);
      const idx = data.traces.findIndex((t) => t.id === trace.id);
      if (idx >= 0) data.traces[idx] = trace;
      else data.traces.unshift(trace);
      data.traces = data.traces.slice(0, MAX_TRACES);
      write(cwd, data);
    },
    get(id) {
      return read(cwd).traces.find((t) => t.id === id);
    },
    list() {
      return read(cwd).traces;
    },
    last() {
      return read(cwd).traces[0];
    },
    resolve(arg) {
      const traces = read(cwd).traces;
      const trimmed = arg.trim();
      if (!trimmed) return traces[0];
      // A small positive integer is a 1-based recency index.
      if (/^\d{1,3}$/.test(trimmed)) {
        const n = Number.parseInt(trimmed, 10);
        if (n >= 1 && n <= traces.length) return traces[n - 1];
      }
      return (
        traces.find((t) => t.id === trimmed) ??
        traces.find((t) => t.id.startsWith(trimmed))
      );
    },
  };
}
