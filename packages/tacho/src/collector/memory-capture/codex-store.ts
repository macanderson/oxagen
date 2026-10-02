/**
 * Codex's memories: the rows of `stage1_outputs` in Codex's SQLite store,
 * `<codex home>/memories_1.sqlite`, one memory per source thread (ADR-248,
 * lane MEM3).
 *
 * A row's `raw_memory` opens with a block of `key: value` lines, with or
 * without `---` rules around it, and its `description:` line is the memory's
 * statement. The rest of `raw_memory` is the memory's detail, about 4 KB, and
 * the ingest contract has no field for it, so it is not sent. The memory's
 * path is `thread/<thread_id>`, so its source is `codex:thread/<thread_id>`.
 * The row's `rollout_slug` travels as the label. Its `usage_count` and
 * `last_usage` are Codex's own count of the memory's uses, which
 * `./memory-counts` turns into `harness_count` uses.
 *
 * The store is opened read-only with `node:sqlite`, read in one query, and
 * closed. A store Codex holds locked answers at once, because the daemon
 * waits on no lock: the read fails, and the scan tries again in five
 * minutes. A missing store means Codex is not installed or keeps no
 * memories. Any other failure is logged once each time it changes, and the
 * store's memories wait for the next scan. Opening the store creates the
 * `-shm` and `-wal` files beside it when Codex is not running, as any
 * SQLite reader of a WAL database does.
 */
import { createRequire } from "node:module";
import {
  frontmatterScalar,
  isMissing,
  type MemoryStore,
  type StoredMemory,
} from "./memory-reader";

/** The store file in Codex's home directory. */
export const CODEX_MEMORY_STORE_FILE = "memories_1.sqlite";

/** The prefix of every Codex memory's path. */
export const CODEX_MEMORY_ROOT = "thread/";

/**
 * The most of each row's `raw_memory` the query returns. The description
 * sits in the first lines, and a row runs to about 4 KB.
 */
const RAW_MEMORY_READ_CHARS = 8_192;

/** The longest thread id the reader takes, so its path fits the contract's 1,024. */
const THREAD_ID_MAX_CHARS = 512;

const QUERY = `SELECT thread_id, substr(raw_memory, 1, ${RAW_MEMORY_READ_CHARS}) AS raw_memory, rollout_slug, generated_at, usage_count, last_usage FROM stage1_outputs ORDER BY thread_id`;

/** One row as the query returns it. Every column is checked before use. */
export interface CodexMemoryRow {
  thread_id: unknown;
  raw_memory: unknown;
  rollout_slug: unknown;
  generated_at: unknown;
  usage_count: unknown;
  last_usage: unknown;
}

export interface CodexMemoryStoreDeps {
  /** The store file. */
  path: string;
  /** Resolves when the file is there. Rejects with the `code` `node:fs` sets. */
  stat: (path: string) => Promise<unknown>;
  /**
   * The rows of `stage1_outputs`, read from the file opened read-only.
   * Defaults to `node:sqlite`. Throws when the store cannot be read.
   */
  query?: (path: string) => CodexMemoryRow[];
  log: (line: string) => void;
}

type SqliteModule = typeof import("node:sqlite");
let sqliteModule: SqliteModule | undefined;

/**
 * `node:sqlite`, loaded on the first read, so a host with no Codex store
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

/** Read every row of `stage1_outputs` from the store at `path`, read-only. */
export function queryCodexStore(path: string): CodexMemoryRow[] {
  const db = new (sqlite().DatabaseSync)(path, { readOnly: true });
  try {
    return db.prepare(QUERY).all() as unknown as CodexMemoryRow[];
  } finally {
    db.close();
  }
}

/** A line that opens or closes the key block: `---`. */
const RULE = /^---[ \t]*$/;

/** The top-level `description:` line of the key block. */
const DESCRIPTION_LINE = /^description[ \t]*:[ \t]*(.*)$/;

/**
 * The statement of a row's `raw_memory`: the value of the `description:`
 * line in its key block. The block runs from the first line, or from the line
 * after an opening `---`, to the first blank line or `---`. Codex indents the
 * keys after `description` in some rows, so only an unindented line counts.
 * A row whose block has no description holds no statement.
 */
export function codexStatementOf(raw: string): string | undefined {
  const lines = raw.replace(/^﻿/, "").split(/\r?\n/);
  const start = RULE.test(lines[0] ?? "") ? 1 : 0;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || RULE.test(line)) return undefined;
    const match = DESCRIPTION_LINE.exec(line);
    if (match === null) continue;
    const value = frontmatterScalar(match[1] ?? "")?.trim();
    return value !== undefined && value.length > 0 ? value : undefined;
  }
  return undefined;
}

/** An epoch-seconds column as an ISO 8601 timestamp, or undefined. */
function isoOfSeconds(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return undefined;
  const at = new Date(value * 1000);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/**
 * The memory one row holds, or undefined when it holds none: no thread id,
 * or no description. A null `usage_count` is a memory Codex never used, so
 * it counts zero. A count that is not a whole number is left out.
 */
export function codexMemoryOf(row: CodexMemoryRow): StoredMemory | undefined {
  const thread = row.thread_id;
  if (
    typeof thread !== "string" ||
    thread.length === 0 ||
    thread.length > THREAD_ID_MAX_CHARS
  )
    return undefined;
  if (typeof row.raw_memory !== "string") return undefined;
  const statement = codexStatementOf(row.raw_memory);
  if (statement === undefined) return undefined;
  const label =
    typeof row.rollout_slug === "string" && row.rollout_slug.trim() !== ""
      ? row.rollout_slug
      : undefined;
  const useCount =
    row.usage_count === null
      ? 0
      : Number.isSafeInteger(row.usage_count) && (row.usage_count as number) >= 0
        ? (row.usage_count as number)
        : undefined;
  const lastUsedAt = isoOfSeconds(row.last_usage);
  return {
    path: `${CODEX_MEMORY_ROOT}${thread}`,
    statement,
    ...(label !== undefined ? { label } : {}),
    modifiedAt: isoOfSeconds(row.generated_at) ?? new Date(0).toISOString(),
    ...(useCount !== undefined ? { useCount } : {}),
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
  };
}

/** Codex's memory store, as the memory reader reads it. */
export function createCodexMemoryStore(deps: CodexMemoryStoreDeps): MemoryStore {
  const query = deps.query ?? queryCodexStore;
  // The last failure logged. A failure is logged when it changes, not at
  // every scan, and a read clears it.
  let lastFailure: string | undefined;

  function unavailable(error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail !== lastFailure) {
      lastFailure = detail;
      deps.log(
        `codex memories: ${deps.path} could not be read (${detail}); its memories wait for the next scan`,
      );
    }
    return { kind: "unavailable" } as const;
  }

  return {
    harness: "codex",
    root: CODEX_MEMORY_ROOT,
    read: async () => {
      try {
        await deps.stat(deps.path);
      } catch (error) {
        if (!isMissing(error)) return unavailable(error);
        lastFailure = undefined;
        return { kind: "missing" };
      }
      let rows: CodexMemoryRow[];
      try {
        rows = query(deps.path);
      } catch (error) {
        return unavailable(error);
      }
      lastFailure = undefined;
      const memories: StoredMemory[] = [];
      for (const row of rows) {
        const memory = codexMemoryOf(row);
        if (memory !== undefined) memories.push(memory);
      }
      return { kind: "read", memories };
    },
  };
}
