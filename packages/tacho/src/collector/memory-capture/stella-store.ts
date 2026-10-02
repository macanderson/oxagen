/**
 * Stella's memories and their uses, read from the two export views Stella
 * keeps in each workspace's `.stella/private/context.db` (lane MEM4). Stella's
 * `crates/stella-context/README.md` lists their columns.
 *
 * - `export_memories_v1` has one row per live memory. Each becomes a memory
 *   whose path is its lineage, so its source is `stella:<lineage>`. The
 *   memory's kind, such as `reflection`, travels as its type.
 * - `export_memory_uses_v1` has one row each time a Stella turn put a memory
 *   in the prompt. Its `seq` only grows, so a reader resumes past the last
 *   one it read. `./stella-memories` sends each row as a `citation` use.
 *
 * The store is opened read-only with `node:sqlite`, read in two queries, and
 * closed. A store without the views was last opened by a Stella older than
 * schema version 14, and it is read once a newer Stella opens it.
 */
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  MEMORY_STATEMENT_MAX_CHARS,
  MEMORY_TYPE_PATTERN,
} from "./memory-reader";

/** Where a Stella workspace keeps its context store, under the workspace root. */
export const STELLA_CONTEXT_DB = join(".stella", "private", "context.db");

/** The view of Stella's live memories. */
export const STELLA_MEMORIES_VIEW = "export_memories_v1";

/** The view of each time a Stella turn used a memory. */
export const STELLA_USES_VIEW = "export_memory_uses_v1";

/** The most use rows one read returns. The next scan reads on from there. */
export const STELLA_USES_PER_READ = 5_000;

/** The longest lineage the reader takes, so its path fits the contract's 1,024. */
const LINEAGE_MAX_CHARS = 1_024;

/** How many folders above a session's folder the store search climbs. */
const WORKSPACE_SEARCH_DEPTH = 64;

/**
 * How far a use's time may sit outside a run's first and last hook and still
 * belong to the run. A turn can finish a little before its last hook or after
 * it, and a sealed run's last hook can come before its final turn ends.
 */
export const STELLA_RUN_SLACK_MS = 10 * 60_000;

/** One live Stella memory. */
export interface StellaMemory {
  lineage: string;
  /** The memory's text, trimmed and clipped. */
  statement: string;
  /** The memory's kind, lowercased. Absent unless it reads as a type. */
  memoryType?: string;
  /** When the current text was written, as an ISO 8601 timestamp. */
  recordedAt: string;
}

/** One time a Stella turn used a memory. */
export interface StellaUse {
  seq: number;
  lineage: string;
  /** The Stella thread the turn ran in. Absent when the turn had none. */
  threadId?: string;
  /** When the turn finished, as an ISO 8601 timestamp. */
  usedAt: string;
}

/** The rows of both views as the queries return them. */
export interface StellaStoreRows {
  memories: Record<string, unknown>[];
  uses: Record<string, unknown>[];
}

type SqliteModule = typeof import("node:sqlite");
let sqliteModule: SqliteModule | undefined;

/**
 * `node:sqlite`, loaded on the first read, so a host with no Stella store
 * never loads it. A static import would not do: vite-node, which runs the
 * tests, strips the `node:` prefix from it and then finds no `sqlite`
 * package.
 */
function sqlite(): SqliteModule {
  sqliteModule ??= createRequire(import.meta.url)(
    "node:sqlite",
  ) as SqliteModule;
  return sqliteModule;
}

/**
 * Read every live memory and the uses past `afterSeq` from the store at
 * `path`, read-only. Undefined when the store has no export views yet.
 * Throws when the store cannot be read.
 */
export function queryStellaStore(
  path: string,
  afterSeq: number,
  limit: number,
): StellaStoreRows | undefined {
  const db = new (sqlite().DatabaseSync)(path, { readOnly: true });
  try {
    const views = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'view' AND name IN (?, ?)",
      )
      .all(STELLA_MEMORIES_VIEW, STELLA_USES_VIEW);
    if (views.length < 2) return undefined;
    const memories = db
      .prepare(
        `SELECT lineage, kind, content, recorded_at FROM ${STELLA_MEMORIES_VIEW} ORDER BY lineage`,
      )
      .all() as unknown as Record<string, unknown>[];
    const uses = db
      .prepare(
        `SELECT seq, lineage, thread_id, used_at FROM ${STELLA_USES_VIEW} WHERE seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(afterSeq, limit) as unknown as Record<string, unknown>[];
    return { memories, uses };
  } finally {
    db.close();
  }
}

/**
 * Clip to `max` UTF-16 units, which is never more code points than the API
 * counts, without splitting a surrogate pair.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end).trimEnd();
}

/** A lineage the contract can carry, or undefined. */
function lineageOf(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= LINEAGE_MAX_CHARS
    ? value
    : undefined;
}

/** A timestamp column as an ISO 8601 timestamp, or undefined. */
function isoOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

/**
 * The memory one row of `export_memories_v1` holds, or undefined when it
 * holds none: no lineage, or no text.
 */
export function stellaMemoryOf(
  row: Record<string, unknown>,
): StellaMemory | undefined {
  const lineage = lineageOf(row["lineage"]);
  const content = row["content"];
  if (lineage === undefined || typeof content !== "string") return undefined;
  const statement = clip(content.trim(), MEMORY_STATEMENT_MAX_CHARS);
  if (statement.length === 0) return undefined;
  const rawKind = row["kind"];
  const kind =
    typeof rawKind === "string" ? rawKind.trim().toLowerCase() : undefined;
  const memoryType =
    kind !== undefined && MEMORY_TYPE_PATTERN.test(kind) ? kind : undefined;
  return {
    lineage,
    statement,
    ...(memoryType !== undefined ? { memoryType } : {}),
    recordedAt: isoOf(row["recorded_at"]) ?? new Date(0).toISOString(),
  };
}

/**
 * The use one row of `export_memory_uses_v1` holds, or undefined when the
 * row is not one: no `seq`, no lineage, or no time.
 */
export function stellaUseOf(
  row: Record<string, unknown>,
): StellaUse | undefined {
  const seq = row["seq"];
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1)
    return undefined;
  const lineage = lineageOf(row["lineage"]);
  const usedAt = isoOf(row["used_at"]);
  if (lineage === undefined || usedAt === undefined) return undefined;
  const thread = row["thread_id"];
  return {
    seq,
    lineage,
    ...(typeof thread === "string" && thread.length > 0
      ? { threadId: thread }
      : {}),
    usedAt,
  };
}

/**
 * A Stella thread id: `ses-<start ms>-<pid>`, as Stella's
 * `SessionRecord::new` mints it. A lane of the thread adds `__<lane>`.
 */
const THREAD_ID = /^ses-(\d{1,16})-(\d{1,10})(?:__.*)?$/;

/** When a Stella thread started and which process ran it. */
export function stellaThreadOf(
  threadId: string,
): { startedMs: number; pid: number } | undefined {
  const match = THREAD_ID.exec(threadId);
  if (match === null) return undefined;
  const startedMs = Number(match[1]);
  const pid = Number(match[2]);
  return Number.isSafeInteger(startedMs) && pid > 0
    ? { startedMs, pid }
    : undefined;
}

/** One Stella run in the daemon's registry. */
export interface StellaRun {
  /** The Stella process's pid. Absent when the registry never learned it. */
  pid?: number;
  /** The run's first hook, as an ISO 8601 timestamp. */
  startedAt: string;
  /** The run's newest hook, as an ISO 8601 timestamp. */
  lastSeenAt: string;
  /** True once the run ended. */
  sealed: boolean;
  /** The run's root session uuid, which `record_tacho_memory_uses` takes. */
  sessionUuid: string;
}

/**
 * The run a Stella use belongs to, or undefined when no one run fits.
 *
 * Tacho names a Stella run by its process, and Stella names a thread by its
 * start time and process id. So the run is the one whose pid is the thread's
 * and whose hooks span the use's time. A pid names one live process at a
 * time, so a run whose span holds the use wins. Failing that, one run whose
 * span holds it within `STELLA_RUN_SLACK_MS` does. Anything else is dropped:
 * a guess would count the use for a run that never had the memory.
 */
export function stellaRunOf(
  use: StellaUse,
  runs: readonly StellaRun[],
  now: number,
): string | undefined {
  if (use.threadId === undefined) return undefined;
  const thread = stellaThreadOf(use.threadId);
  if (thread === undefined) return undefined;
  const at = Date.parse(use.usedAt);
  const exact: StellaRun[] = [];
  const near: StellaRun[] = [];
  for (const run of runs) {
    if (run.pid !== thread.pid) continue;
    const start = Date.parse(run.startedAt);
    const end = run.sealed ? Date.parse(run.lastSeenAt) : now;
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    // The run ended before the thread began, so another process held the pid.
    if (end + STELLA_RUN_SLACK_MS < thread.startedMs) continue;
    if (start <= at && at <= end) exact.push(run);
    else if (
      start - STELLA_RUN_SLACK_MS <= at &&
      at <= end + STELLA_RUN_SLACK_MS
    )
      near.push(run);
  }
  if (exact.length === 1) return exact[0]?.sessionUuid;
  if (exact.length === 0 && near.length === 1) return near[0]?.sessionUuid;
  return undefined;
}

/**
 * The Stella context store of the workspace `dir` is in: the nearest
 * `.stella/private/context.db` at or above it. Undefined when there is none.
 */
export async function stellaStoreOf(
  dir: string,
  exists: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  if (!isAbsolute(dir)) return undefined;
  let at = resolve(dir);
  for (let depth = 0; depth < WORKSPACE_SEARCH_DEPTH; depth += 1) {
    const candidate = join(at, STELLA_CONTEXT_DB);
    if (await exists(candidate)) return candidate;
    const up = dirname(at);
    if (up === at) return undefined;
    at = up;
  }
  return undefined;
}
