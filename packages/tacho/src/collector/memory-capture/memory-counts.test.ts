/**
 * Memory counts (`memory-counts.ts`): the rise in a harness's own use counts
 * between scans, what a fall or a missing memory does to it, and what
 * survives a daemon restart.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createUseCountLedger,
  fileUseCountStorage,
  MEMORY_COUNTS_STATE_SCHEMA,
  type UseCountStorage,
} from "./memory-counts";
import type { HarnessUseCounts } from "./memory-reader";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const USED = "2026-09-30T08:00:00.000Z";

/** Storage that keeps the last saved state in memory, as a file would. */
function memoryStorage(initial?: unknown) {
  const storage = {
    state: initial === undefined ? undefined : JSON.stringify(initial),
    saves: 0,
    load: () =>
      storage.state === undefined ? undefined : JSON.parse(storage.state),
    save: (json: string) => {
      storage.state = json;
      storage.saves += 1;
    },
  };
  return storage;
}

function ledger(storage: UseCountStorage) {
  const lines: string[] = [];
  const counts = createUseCountLedger({
    storage,
    log: (line) => lines.push(line),
    now: () => NOW,
  });
  return { counts, lines };
}

/** A full read of the Codex store with these counts. */
/** A read of `counts`. Pass `null` for rows with no last use: an explicit
 * `undefined` would take the default instead. */
function read(
  counts: Record<string, number>,
  lastUsedAt: string | null = USED,
): HarnessUseCounts {
  return {
    harness: "codex",
    root: "thread/",
    counts: Object.entries(counts).map(([thread, count]) => ({
      path: `thread/${thread}`,
      count,
      ...(lastUsedAt !== null ? { lastUsedAt } : {}),
    })),
  };
}

describe("the rise in a count", () => {
  it("counts from zero for a memory seen the first time", () => {
    const { counts } = ledger(memoryStorage());
    expect(counts.rises([read({ t1: 4, t2: 0, t3: 1 })])).toEqual([
      { harness: "codex", path: "thread/t1", count: 4, usedAt: USED, through: 4 },
      { harness: "codex", path: "thread/t3", count: 1, usedAt: USED, through: 1 },
    ]);
  });

  it("is the difference from the count the last report settled", () => {
    const { counts } = ledger(memoryStorage());
    counts.settle(counts.rises([read({ t1: 4 })]));
    expect(counts.rises([read({ t1: 4 })])).toEqual([]);
    expect(counts.rises([read({ t1: 7 })])).toEqual([
      { harness: "codex", path: "thread/t1", count: 3, usedAt: USED, through: 7 },
    ]);
  });

  it("is worked out again until a report settles it", () => {
    const { counts } = ledger(memoryStorage());
    expect(counts.rises([read({ t1: 2 })])[0]?.count).toBe(2);
    // The report never landed. Codex counted one more use since.
    expect(counts.rises([read({ t1: 3 })])[0]?.count).toBe(3);
  });

  it("starts over from a count that fell", () => {
    const storage = memoryStorage();
    const { counts } = ledger(storage);
    counts.settle(counts.rises([read({ t1: 5 })]));
    // Codex wrote the row again, and its count began again at 1.
    expect(counts.rises([read({ t1: 1 })])).toEqual([]);
    expect(JSON.parse(storage.state ?? "{}").counts).toEqual({
      codex: { "thread/t1": 1 },
    });
    expect(counts.rises([read({ t1: 3 })])).toEqual([
      { harness: "codex", path: "thread/t1", count: 2, usedAt: USED, through: 3 },
    ]);
  });

  it("saves nothing for a count that fell to zero", () => {
    const storage = memoryStorage();
    const { counts } = ledger(storage);
    counts.settle(counts.rises([read({ t1: 2 })]));
    expect(counts.rises([read({ t1: 0 })])).toEqual([]);
    expect(JSON.parse(storage.state ?? "{}").counts).toEqual({});
  });

  it("forgets a memory a full read no longer found, and counts it from zero if it comes back", () => {
    const { counts } = ledger(memoryStorage());
    counts.settle(counts.rises([read({ t1: 5, t2: 1 })]));
    expect(counts.rises([read({ t2: 1 })])).toEqual([]);
    expect(counts.rises([read({ t1: 5, t2: 1 })])).toEqual([
      { harness: "codex", path: "thread/t1", count: 5, usedAt: USED, through: 5 },
    ]);
  });

  it("forgets nothing when the store was not read", () => {
    const { counts } = ledger(memoryStorage());
    counts.settle(counts.rises([read({ t1: 5 })]));
    // A missing or locked store hands back no read at all.
    expect(counts.rises([])).toEqual([]);
    expect(counts.rises([read({ t1: 5 })])).toEqual([]);
  });

  it("forgets nothing under another harness's root", () => {
    const { counts } = ledger(memoryStorage());
    counts.settle(counts.rises([read({ t1: 5 })]));
    counts.rises([{ harness: "stella", root: "lineage/", counts: [] }]);
    expect(counts.rises([read({ t1: 5 })])).toEqual([]);
  });

  it("stamps a rise with no last use at the scan's time", () => {
    const { counts } = ledger(memoryStorage());
    expect(counts.rises([read({ t1: 1 }, null)])[0]?.usedAt).toBe(
      new Date(NOW).toISOString(),
    );
  });

  it("carries at most 10,000 uses, and the rest at the next report", () => {
    const { counts } = ledger(memoryStorage());
    const first = counts.rises([read({ t1: 12_345 })]);
    expect(first).toEqual([
      {
        harness: "codex",
        path: "thread/t1",
        count: 10_000,
        usedAt: USED,
        through: 10_000,
      },
    ]);
    counts.settle(first);
    expect(counts.rises([read({ t1: 12_345 })])[0]?.count).toBe(2_345);
  });

  it("skips a count that is not a whole number of uses", () => {
    const { counts } = ledger(memoryStorage());
    expect(counts.rises([read({ t1: -1, t2: 1.5, t3: Number.NaN })])).toEqual(
      [],
    );
  });
});

describe("a restart", () => {
  it("reports nothing Codex counted before the last report", () => {
    const storage = memoryStorage();
    const before = ledger(storage).counts;
    before.settle(before.rises([read({ t1: 4, t2: 1 })]));

    const after = ledger(storage).counts;
    expect(after.rises([read({ t1: 4, t2: 1 })])).toEqual([]);
    expect(after.rises([read({ t1: 6, t2: 1 })])).toEqual([
      { harness: "codex", path: "thread/t1", count: 2, usedAt: USED, through: 6 },
    ]);
  });

  it("reports again a rise the last report never settled", () => {
    const storage = memoryStorage();
    ledger(storage).counts.rises([read({ t1: 4 })]);
    expect(ledger(storage).counts.rises([read({ t1: 4 })])[0]?.count).toBe(4);
  });

  it("reads the counts a file saved", () => {
    const dir = mkdtempSync(join(tmpdir(), "tacho-memory-counts-"));
    const path = join(dir, "memory-counts.json");
    const before = ledger(fileUseCountStorage(path, () => {})).counts;
    before.settle(before.rises([read({ t1: 3 })]));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      schema: MEMORY_COUNTS_STATE_SCHEMA,
      counts: { codex: { "thread/t1": 3 } },
    });

    const after = ledger(fileUseCountStorage(path, () => {})).counts;
    expect(after.rises([read({ t1: 3 })])).toEqual([]);
  });

  it("sets a file that does not parse aside and counts from zero", () => {
    const dir = mkdtempSync(join(tmpdir(), "tacho-memory-counts-"));
    const path = join(dir, "memory-counts.json");
    writeFileSync(path, "{ not json");
    const lines: string[] = [];
    const counts = createUseCountLedger({
      storage: fileUseCountStorage(path, (line) => lines.push(line)),
      log: (line) => lines.push(line),
      now: () => NOW,
    });
    expect(counts.rises([read({ t1: 2 })])[0]?.count).toBe(2);
    expect(lines).toHaveLength(1);
    expect(readdirSync(dir).some((name) => name.includes(".corrupt-"))).toBe(
      true,
    );
  });

  it("ignores a saved state of another schema", () => {
    const { counts } = ledger(
      memoryStorage({ schema: "tacho.other.v1", counts: { codex: { "thread/t1": 9 } } }),
    );
    expect(counts.rises([read({ t1: 9 })])[0]?.count).toBe(9);
  });

  it("reports no count while the saved state cannot be read, so no use counts twice", () => {
    const { counts, lines } = ledger({
      load: () => {
        throw Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        });
      },
      save: () => {
        throw new Error("never saved");
      },
    });
    expect(counts.rises([read({ t1: 4 })])).toEqual([]);
    expect(lines).toEqual([
      "memory counts: the saved counts could not be read (EACCES: permission denied); no harness count is reported until the daemon restarts",
    ]);
  });

  it("logs a save that failed once, until it changes", () => {
    const { counts, lines } = ledger({
      load: () => undefined,
      save: () => {
        throw new Error("ENOSPC: no space left on device");
      },
    });
    counts.settle(counts.rises([read({ t1: 1 })]));
    counts.settle(counts.rises([read({ t1: 2 })]));
    expect(lines).toHaveLength(1);
    // The counts still hold in memory, so this daemon reports no rise twice.
    expect(counts.rises([read({ t1: 2 })])).toEqual([]);
  });
});
