/**
 * Stella memory capture (lane MEM4). Each Stella workspace's memories go to
 * Oxagen as memories with source `stella:<lineage>`, and each time a Stella
 * turn put one in the prompt counts as a `citation` use of it.
 * `./stella-store` reads the two export views Stella keeps for this.
 *
 * The daemon learns where Stella works from its own registry: the folder of
 * each Stella run leads to the nearest `.stella/private/context.db`. The
 * reader keeps every store it found in the agent's
 * `stella-memory-cursors.json`, with the `seq` of the last use it took. So a
 * store stays read after its runs leave the registry, and a restart counts
 * no use twice.
 *
 * - A memory is sent when it is new or its text changed, as a memory file
 *   is. A failed send stops the scan's sends, and the rest wait for the next
 *   scan.
 * - A use counts only once its memory was sent, so Oxagen holds the memory
 *   when the use lands. A use of a memory not sent yet holds the cursor, and
 *   the next scan reads on from it.
 * - A use whose run the registry does not hold is dropped. Oxagen records no
 *   run for it, so the use could never land.
 * - A full use queue holds the cursor too.
 *
 * No scan list goes out for Stella. A scan names a folder, and a source of
 * `stella:<lineage>` has none. So a memory Stella forgets stays in Oxagen
 * until it retires for want of use.
 */
import { digestBytes, type Sha256Digest } from "../../digest";
import { readJsonStateFile, writeSensitiveFileAtomic } from "../../host/fs";
import type { LocalMemoryEntry } from "./memory-reader";
import { MEMORY_USES_QUEUED_MAX, type MemoryUses } from "./memory-uses";
import {
  queryStellaStore,
  STELLA_USES_PER_READ,
  type StellaMemory,
  type StellaRun,
  type StellaStoreRows,
  stellaMemoryOf,
  stellaRunOf,
  stellaStoreOf,
  stellaUseOf,
} from "./stella-store";

/** The schema `stella-memory-cursors.json` carries. */
export const STELLA_CURSORS_STATE_SCHEMA = "tacho.stella-memory-cursors.v1";

/** One Stella run, with the folders it started or worked in. */
export interface StellaRunRecord extends StellaRun {
  dirs: readonly string[];
}

/** The registry facts `stellaRunsOf` reads from each session. */
export interface StellaSessionFacts {
  harness?: string;
  customAgent?: string;
  pid?: number;
  cwd?: string;
  workDir?: string;
  startedAt: string;
  lastSeenAt: string;
  sealed: boolean;
  recorder: { rootSessionUuid: string };
}

/** The Stella runs among the registry's sessions. */
export function stellaRunsOf(
  sessions: readonly StellaSessionFacts[],
): StellaRunRecord[] {
  const runs: StellaRunRecord[] = [];
  for (const session of sessions) {
    if (session.harness !== "stella" || session.customAgent !== undefined)
      continue;
    runs.push({
      ...(session.pid !== undefined ? { pid: session.pid } : {}),
      startedAt: session.startedAt,
      lastSeenAt: session.lastSeenAt,
      sealed: session.sealed,
      sessionUuid: session.recorder.rootSessionUuid,
      dirs: [session.cwd, session.workDir].filter(
        (dir): dir is string => dir !== undefined && dir.length > 0,
      ),
    });
  }
  return runs;
}

/** Where the cursors are kept between daemon runs. */
export interface StellaCursorStorage {
  /**
   * The state as last saved, or undefined when none was. Throws when the
   * state is there and cannot be read.
   */
  load: () => unknown;
  save: (json: string) => void;
}

export interface StellaMemoriesDeps {
  /** The Stella runs in the daemon's registry. Read at every scan. */
  runs: () => readonly StellaRunRecord[];
  /** Whether a file is there. */
  exists: (path: string) => Promise<boolean>;
  /** Read one store. Defaults to `queryStellaStore`. */
  read?: (
    path: string,
    afterSeq: number,
    limit: number,
  ) => StellaStoreRows | undefined;
  storage: StellaCursorStorage;
  /** Upload one memory. A rejection leaves it unsent for the next scan. */
  send: (entry: LocalMemoryEntry) => Promise<void>;
  /** The use queue `record_tacho_memory_uses` reports from. */
  uses: Pick<MemoryUses, "note" | "size">;
  log: (line: string) => void;
  now: () => number;
}

/** What one scan did. */
export interface StellaScanResult {
  /** Memories sent. */
  sent: number;
  /** Uses queued as citations. */
  cited: number;
}

export interface StellaMemories {
  /** Read every known store once. It never throws. */
  scan: () => Promise<StellaScanResult>;
}

/** A saved cursor map, keeping only the entries that read as cursors. */
function cursorsOf(state: unknown): Map<string, number> {
  const cursors = new Map<string, number>();
  if (typeof state !== "object" || state === null) return cursors;
  const record = state as { schema?: unknown; stores?: unknown };
  if (record.schema !== STELLA_CURSORS_STATE_SCHEMA) return cursors;
  if (typeof record.stores !== "object" || record.stores === null)
    return cursors;
  for (const [path, seq] of Object.entries(
    record.stores as Record<string, unknown>,
  ))
    if (Number.isSafeInteger(seq) && (seq as number) >= 0)
      cursors.set(path, seq as number);
  return cursors;
}

/** The cursors as `stella-memory-cursors.json` holds them. */
function stateOf(cursors: ReadonlyMap<string, number>): string {
  return JSON.stringify({
    schema: STELLA_CURSORS_STATE_SCHEMA,
    stores: Object.fromEntries(
      [...cursors].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  });
}

/** Storage in one file, written whole and owner-only. */
export function fileStellaCursorStorage(
  path: string,
  log: (line: string) => void,
): StellaCursorStorage {
  return {
    load: () =>
      readJsonStateFile(path, (movedTo) =>
        log(
          movedTo === undefined
            ? "stella memories: the saved cursors did not parse and could not be moved aside; every store is read from its first use"
            : `stella memories: the saved cursors did not parse; moved them to ${movedTo}, and every store is read from its first use`,
        ),
      ),
    save: (json) => writeSensitiveFileAtomic(path, json),
  };
}

/** The entry the memory upload sends for one Stella memory. */
function entryOf(memory: StellaMemory): LocalMemoryEntry {
  return {
    harness: "stella",
    path: memory.lineage,
    statement: memory.statement,
    contentDigest: digestBytes(memory.statement),
    modifiedAt: memory.recordedAt,
    ...(memory.memoryType !== undefined
      ? { memoryType: memory.memoryType }
      : {}),
  };
}

/** The digest the reader compares between scans: the text and the type. */
function sentDigest(memory: StellaMemory): Sha256Digest {
  return digestBytes(
    JSON.stringify([memory.statement, memory.memoryType ?? null]),
  );
}

export function createStellaMemories(deps: StellaMemoriesDeps): StellaMemories {
  const read = deps.read ?? queryStellaStore;
  let cursors = new Map<string, number>();
  // A state file that is there and cannot be read holds cursors this reader
  // does not know. Reading from the first use again would count uses twice,
  // so no use is counted until the daemon starts again. Memories still go.
  let blind = false;
  try {
    cursors = cursorsOf(deps.storage.load());
  } catch (error) {
    blind = true;
    deps.log(
      `stella memories: the saved cursors could not be read (${error instanceof Error ? error.message : String(error)}); no Stella use is counted until the daemon restarts`,
    );
  }
  /** The digest of what was last sent, by store and lineage. */
  const sent = new Map<string, Sha256Digest>();
  /** The last failure logged for each store. */
  const failures = new Map<string, string>();
  const viewsMissingLogged = new Set<string>();
  let saveFailure: string | undefined;
  let running: Promise<StellaScanResult> | undefined;

  const sentKey = (store: string, lineage: string) => `${store}\n${lineage}`;

  function save(): void {
    try {
      deps.storage.save(stateOf(cursors));
      saveFailure = undefined;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail === saveFailure) return;
      saveFailure = detail;
      deps.log(
        `stella memories: the cursors could not be saved (${detail}); a restart reads the uses since the last save again`,
      );
    }
  }

  /** Every store the cursors name, and each one a run's folder leads to. */
  async function storesNow(
    runs: readonly StellaRunRecord[],
  ): Promise<string[]> {
    const stores = new Set(cursors.keys());
    const looked = new Map<string, string | undefined>();
    for (const run of runs)
      for (const dir of run.dirs) {
        if (!looked.has(dir))
          looked.set(dir, await stellaStoreOf(dir, deps.exists));
        const store = looked.get(dir);
        if (store !== undefined) stores.add(store);
      }
    return [...stores].sort();
  }

  async function scanOnce(): Promise<StellaScanResult> {
    const result: StellaScanResult = { sent: 0, cited: 0 };
    const runs = deps.runs();
    let sending = true;
    let changed = false;
    for (const store of await storesNow(runs)) {
      if (!(await deps.exists(store))) {
        // The workspace is gone. Its memories retire for want of use.
        if (cursors.delete(store)) changed = true;
        for (const key of [...sent.keys()])
          if (key.startsWith(`${store}\n`)) sent.delete(key);
        continue;
      }
      const after = cursors.get(store) ?? 0;
      let rows: StellaStoreRows | undefined;
      try {
        rows = read(store, after, STELLA_USES_PER_READ);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (failures.get(store) !== detail) {
          failures.set(store, detail);
          deps.log(
            `stella memories: ${store} could not be read (${detail}); its memories wait for the next scan`,
          );
        }
        continue;
      }
      failures.delete(store);
      if (rows === undefined) {
        if (!viewsMissingLogged.has(store)) {
          viewsMissingLogged.add(store);
          deps.log(
            `stella memories: ${store} has no export views; they arrive when a Stella with context schema 14 or later opens the workspace`,
          );
        }
        continue;
      }
      viewsMissingLogged.delete(store);
      if (!cursors.has(store)) {
        cursors.set(store, 0);
        changed = true;
      }

      const live = new Map<string, StellaMemory>();
      for (const row of rows.memories) {
        const memory = stellaMemoryOf(row);
        if (memory !== undefined) live.set(memory.lineage, memory);
      }
      for (const memory of live.values()) {
        if (!sending) break;
        const key = sentKey(store, memory.lineage);
        const digest = sentDigest(memory);
        if (sent.get(key) === digest) continue;
        try {
          await deps.send(entryOf(memory));
        } catch {
          // A failed send is almost always the API's failure, so every send
          // after it would fail too. They wait for the next scan.
          sending = false;
          break;
        }
        sent.set(key, digest);
        result.sent += 1;
      }
      // A memory Stella no longer holds live is sent again if it returns.
      for (const key of [...sent.keys()])
        if (
          key.startsWith(`${store}\n`) &&
          !live.has(key.slice(store.length + 1))
        )
          sent.delete(key);

      if (blind) continue;
      let cursor = after;
      for (const row of rows.uses) {
        const use = stellaUseOf(row);
        if (use === undefined) {
          // A row the reader cannot use is passed over, never retried.
          const seq = row["seq"];
          if (typeof seq === "number" && Number.isSafeInteger(seq))
            cursor = Math.max(cursor, seq);
          continue;
        }
        if (live.has(use.lineage) && !sent.has(sentKey(store, use.lineage)))
          break;
        const run = stellaRunOf(use, runs, deps.now());
        if (run !== undefined) {
          if (deps.uses.size() >= MEMORY_USES_QUEUED_MAX) break;
          const queued = deps.uses.note({
            harness: "stella",
            path: use.lineage,
            sessionUuid: run,
            at: use.usedAt,
            signal: "citation",
          });
          if (!queued) break;
          result.cited += 1;
        }
        cursor = use.seq;
      }
      if (cursor !== after) {
        cursors.set(store, cursor);
        changed = true;
      }
    }
    if (changed) save();
    return result;
  }

  return {
    // A scan that overlaps one still running joins it, so no memory is sent
    // twice at once and no use is queued twice.
    scan: () => {
      running ??= scanOnce()
        .catch((error: unknown) => {
          deps.log(
            `stella memories: the scan failed (${error instanceof Error ? error.message : String(error)})`,
          );
          return { sent: 0, cited: 0 };
        })
        .finally(() => {
          running = undefined;
        });
      return running;
    },
  };
}
