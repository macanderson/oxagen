/**
 * Memory counts: the uses a harness counted itself, turned into the rise
 * since the last report (ADR-245, lane MEM3).
 *
 * Codex keeps a `usage_count` on each memory row. Each memory scan reads the
 * count every row holds now (`./codex-store`), and `rises` compares it with
 * the count this host last reported. The difference is a `harness_count` use
 * for `record_tacho_memory_uses` (`./memory-uses`). `settle` records the new
 * count once the control plane took the rise, and writes it to the agent's
 * `memory-counts.json`, so a daemon restart reports only what Codex counted
 * since.
 *
 * - A memory seen for the first time counts from zero, so the uses Codex
 *   counted before Tacho read the store are reported once.
 * - A count that falls, as when Codex writes the row again, becomes the new
 *   base, and only a rise past it is reported.
 * - A memory gone from a full read of its store is forgotten. A store that
 *   is missing or could not be read forgets nothing, because forgetting
 *   would report every count again once the store comes back.
 * - A rise is worked out again at each scan until a report lands, so a
 *   report the control plane never took loses no use.
 *
 * A daemon that stops between a report the control plane took and the write
 * of `memory-counts.json` reports that rise again after the restart. The
 * window is one file write long.
 */
import { readJsonStateFile, writeSensitiveFileAtomic } from "../../host/fs";
import type { TachoHarness } from "../../wire";
import type { HarnessUseCounts } from "./memory-reader";

/** The schema `memory-counts.json` carries. */
export const MEMORY_COUNTS_STATE_SCHEMA = "tacho.memory-counts.v1";

/**
 * The largest count one rise carries. It mirrors the `count` bound of
 * `record_tacho_memory_uses`, which this leaf package cannot import. A
 * larger rise is reported over several scans.
 */
const RISE_MAX = 10_000;

/** One rise in a harness's own count of a memory's uses. */
export interface UseCountRise {
  harness: TachoHarness;
  /** The memory's path in its store, such as `thread/<thread_id>`. */
  path: string;
  /** The uses the harness counted since the last report. At least 1. */
  count: number;
  /** When the harness last used the memory, as an ISO 8601 timestamp. */
  usedAt: string;
  /** The count the harness held that this rise reaches. `settle` records it. */
  through: number;
}

/** Where the counts are kept between daemon runs. */
export interface UseCountStorage {
  /**
   * The state as last saved, or undefined when none was. Throws when the
   * state is there and cannot be read.
   */
  load: () => unknown;
  save: (json: string) => void;
}

export interface UseCountLedgerDeps {
  storage: UseCountStorage;
  log: (line: string) => void;
  now: () => number;
}

export interface UseCountLedger {
  /**
   * The rise in each memory's count since the last report, from full reads
   * of the stores. It also records each count that fell and forgets each
   * memory a read no longer found.
   */
  rises: (reads: readonly HarnessUseCounts[]) => UseCountRise[];
  /** Record that the control plane took these rises, or refused them for good. */
  settle: (rises: readonly UseCountRise[]) => void;
}

/** The key the ledger keeps a count under: its harness and its path. */
const keyOf = (harness: TachoHarness, path: string) => `${harness}\n${path}`;

/** A saved count map, keeping only the entries that read as counts. */
function countsOf(state: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  if (typeof state !== "object" || state === null) return counts;
  const record = state as { schema?: unknown; counts?: unknown };
  if (record.schema !== MEMORY_COUNTS_STATE_SCHEMA) return counts;
  if (typeof record.counts !== "object" || record.counts === null)
    return counts;
  for (const [harness, paths] of Object.entries(
    record.counts as Record<string, unknown>,
  )) {
    if (typeof paths !== "object" || paths === null) continue;
    for (const [path, count] of Object.entries(
      paths as Record<string, unknown>,
    ))
      if (Number.isSafeInteger(count) && (count as number) > 0)
        counts.set(keyOf(harness as TachoHarness, path), count as number);
  }
  return counts;
}

/** The counts as `memory-counts.json` holds them: harness, then path. */
function stateOf(counts: ReadonlyMap<string, number>): string {
  const byHarness: Record<string, Record<string, number>> = {};
  for (const [key, count] of counts) {
    const split = key.indexOf("\n");
    const harness = key.slice(0, split);
    const path = key.slice(split + 1);
    (byHarness[harness] ??= {})[path] = count;
  }
  return JSON.stringify({
    schema: MEMORY_COUNTS_STATE_SCHEMA,
    counts: byHarness,
  });
}

/** Storage in one file, written whole and owner-only. */
export function fileUseCountStorage(
  path: string,
  log: (line: string) => void,
): UseCountStorage {
  return {
    load: () =>
      readJsonStateFile(path, (movedTo) =>
        log(
          movedTo === undefined
            ? "memory counts: the saved counts did not parse and could not be moved aside; every count is reported from zero"
            : `memory counts: the saved counts did not parse; moved them to ${movedTo}, and every count is reported from zero`,
        ),
      ),
    save: (json) => writeSensitiveFileAtomic(path, json),
  };
}

export function createUseCountLedger(deps: UseCountLedgerDeps): UseCountLedger {
  let counts = new Map<string, number>();
  // A state file that is there and cannot be read holds counts this ledger
  // does not know. Reporting from zero would count those uses twice, so the
  // ledger reports nothing until the daemon starts again.
  let blind = false;
  try {
    counts = countsOf(deps.storage.load());
  } catch (error) {
    blind = true;
    deps.log(
      `memory counts: the saved counts could not be read (${error instanceof Error ? error.message : String(error)}); no harness count is reported until the daemon restarts`,
    );
  }
  let lastFailure: string | undefined;

  function save(): void {
    try {
      deps.storage.save(stateOf(counts));
      lastFailure = undefined;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail === lastFailure) return;
      lastFailure = detail;
      deps.log(
        `memory counts: the counts could not be saved (${detail}); a restart reports the rises since the last save again`,
      );
    }
  }

  return {
    rises: (reads) => {
      if (blind) return [];
      const rises: UseCountRise[] = [];
      let changed = false;
      for (const read of reads) {
        const present = new Set<string>();
        for (const { path, count, lastUsedAt } of read.counts) {
          if (!Number.isSafeInteger(count) || count < 0) continue;
          const key = keyOf(read.harness, path);
          present.add(key);
          const base = counts.get(key) ?? 0;
          if (count < base) {
            // Codex wrote the row again and its count started over.
            if (count === 0) counts.delete(key);
            else counts.set(key, count);
            changed = true;
            continue;
          }
          if (count === base) continue;
          const rise = Math.min(count - base, RISE_MAX);
          rises.push({
            harness: read.harness,
            path,
            count: rise,
            usedAt: lastUsedAt ?? new Date(deps.now()).toISOString(),
            through: base + rise,
          });
        }
        const prefix = keyOf(read.harness, read.root);
        for (const key of [...counts.keys()])
          if (key.startsWith(prefix) && !present.has(key)) {
            counts.delete(key);
            changed = true;
          }
      }
      if (changed) save();
      return rises;
    },
    settle: (rises) => {
      if (rises.length === 0) return;
      for (const rise of rises)
        counts.set(keyOf(rise.harness, rise.path), rise.through);
      save();
    },
  };
}
