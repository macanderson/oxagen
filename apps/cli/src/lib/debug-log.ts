/**
 * `OXAGEN_CLI_DEBUG` file log — the CLI's debuggable `.output` stream.
 *
 * When `OXAGEN_CLI_DEBUG=1` (either exported in the shell or projected from
 * `settings.json` `env` via {@link applySettingsToEnv}), every CLI invocation and
 * every request the CLI makes is appended as one JSON object per line (JSONL) to:
 *
 *   ~/.oxagen/logs/cli.output
 *
 * `~/.oxagen/` is the same home root that holds the user-level `settings.json`
 * (see settings/resolve.ts `userSettingsFile()`), so the debug log lives beside
 * the global settings it belongs to. This is the machine-readable record you
 * `tail`/`jq` (or `oxagen logs`) to see exactly what the CLI is sending: the
 * command invoked, the per-turn LLM telemetry, and local code-graph queries.
 *
 * Writes are best-effort and fire-and-forget: a failed log write must never
 * break a command or a turn. Callers use `void debugLog(...)`.
 */
import {
  appendFile,
  mkdir,
  rename,
  stat,
  readFile,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The env var that gates all file logging. `"1"` or `"true"` enables it. */
export const DEBUG_ENV = "OXAGEN_CLI_DEBUG";

/** Rotate the log once it exceeds this size, keeping a single `.1` backup. */
const MAX_BYTES = 10 * 1024 * 1024;

/** Cap any single string value so one huge payload can't blow up a line. */
const MAX_STRING = 50_000;

/** Keys whose values are secrets and must never be written to disk. */
const REDACT_KEYS = new Set([
  "token",
  "authorization",
  "apikey",
  "api_key",
  "apitoken",
  "gatewaykey",
  "password",
  "secret",
  "bearer",
  "cookie",
]);

/** Categories a debug entry can carry, so `oxagen logs` / `jq` can filter. */
export type DebugCategory =
  | "invoke" // CLI process start (argv, cwd)
  | "turn" // agent turn lifecycle: stages, tool calls, output
  | "api" // generic org-scoped /v1 request+response
  | "code-graph" // local code-graph queries (symbols, calls, refs) served from the daemon store
  | "llm" // per-turn LLM telemetry (model, usage) routed through the platform
  | "pipeline" // assist-tool lifecycle: prompt enhancer, judge, survey (Group 4)
  | "timeout" // per-model-call timeout retries + turn inactivity guard (Group 8)
  | "error";

/** Is file logging enabled for this process? */
export function isDebugEnabled(): boolean {
  const v = process.env[DEBUG_ENV];
  return v === "1" || v === "true";
}

/** Directory the debug log lives in: `~/.oxagen/logs`. */
export function logsDir(): string {
  return join(homedir(), ".oxagen", "logs");
}

/** Absolute path of the JSONL debug log. */
export function debugLogFile(): string {
  return join(logsDir(), "cli.output");
}

/**
 * Deep-redact secrets and cap oversized strings so nothing sensitive or
 * pathologically large lands in the log. Returns a JSON-safe clone.
 */
function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING} chars]`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 8) return "[max-depth]";
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACT_KEYS.has(key.toLowerCase())
        ? "[redacted]"
        : sanitize(v, depth + 1);
    }
    return out;
  }
  // Functions, symbols, bigint, etc. — stringify defensively.
  return String(value);
}

/** Rename the log to a single `.1` backup once it grows past {@link MAX_BYTES}. */
async function rotateIfNeeded(file: string): Promise<void> {
  try {
    const info = await stat(file);
    if (info.size > MAX_BYTES) await rename(file, `${file}.1`);
  } catch {
    // File doesn't exist yet, or rename raced another process — either way the
    // append below will (re)create it. Rotation is best-effort.
  }
}

/**
 * Append one entry to the debug log. No-op (and cheap) unless
 * `OXAGEN_CLI_DEBUG` is enabled. Never throws — a logging failure must not
 * break the command or turn that produced it.
 */
export async function debugLog(
  category: DebugCategory,
  event: string,
  data?: unknown,
): Promise<void> {
  if (!isDebugEnabled()) return;
  try {
    const dir = logsDir();
    const file = debugLogFile();
    await mkdir(dir, { recursive: true });
    await rotateIfNeeded(file);
    const entry = {
      ts: new Date().toISOString(),
      pid: process.pid,
      category,
      event,
      ...(data === undefined ? {} : { data: sanitize(data) }),
    };
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    // Surface under the generic OXAGEN_DEBUG flag so a silently-missing entry
    // can be diagnosed, but never propagate.
    if (process.env["OXAGEN_DEBUG"]) {
      process.stderr.write(
        `[debug-log] append failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

/** One parsed debug-log entry. `data` is the sanitized payload, when present. */
export interface DebugLogEntry {
  ts: string;
  pid: number;
  category: DebugCategory;
  event: string;
  data?: unknown;
}

/**
 * Read the last `limit` entries from the debug log (newest last), skipping
 * malformed lines. Returns `[]` when the log does not exist.
 */
export async function readDebugLog(limit = 50): Promise<DebugLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(debugLogFile(), "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const out: DebugLogEntry[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line) as DebugLogEntry);
    } catch {
      /* skip a corrupt/partial line rather than failing the whole read */
    }
  }
  return out;
}

/** Truncate the debug log to empty. Best-effort; safe if the file is absent. */
export async function clearDebugLog(): Promise<void> {
  try {
    await mkdir(logsDir(), { recursive: true });
    await writeFile(debugLogFile(), "", "utf8");
  } catch (err) {
    if (process.env["OXAGEN_DEBUG"]) {
      process.stderr.write(
        `[debug-log] clear failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}
