/**
 * The Stella scanner (`stella-memories.ts`) against stores it reads through
 * a fake: which memories it sends, which uses it queues as citations, where
 * its cursor stops, and what it keeps across a restart.
 * `stella-store.test.ts` runs it against a real store.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestBytes } from "../../digest";
import type { LocalMemoryEntry } from "./memory-reader";
import { type MemoryRead, MEMORY_USES_QUEUED_MAX } from "./memory-uses";
import {
  createStellaMemories,
  STELLA_CURSORS_STATE_SCHEMA,
  type StellaRunRecord,
  stellaRunsOf,
} from "./stella-memories";
import { STELLA_CONTEXT_DB, type StellaStoreRows } from "./stella-store";

const APP = "/work/app";
const STORE = join(APP, STELLA_CONTEXT_DB);
const RUN = "0b3f8a52-8d2c-4f0e-9a49-6f1c2d3e4a5b";
const THREAD = "ses-1790000000000-4242";
const NOW = Date.parse("2026-09-21T16:00:00.000Z");

const RUNS: StellaRunRecord[] = [
  {
    pid: 4242,
    startedAt: "2026-09-21T14:13:21.000Z",
    lastSeenAt: "2026-09-21T15:00:00.000Z",
    sealed: true,
    sessionUuid: RUN,
    dirs: [join(APP, "src")],
  },
];

const memoryRow = (lineage: string, content = `text of ${lineage}`) => ({
  lineage,
  kind: "reflection",
  content,
  recorded_at: "2026-08-01T00:00:00Z",
});

const useRow = (
  seq: number,
  lineage: string,
  over: Record<string, unknown> = {},
) => ({
  seq,
  lineage,
  thread_id: THREAD,
  used_at: "2026-09-21T14:30:00Z",
  ...over,
});

interface Fixture {
  /** What each store answers, by path. Undefined answers no views. */
  rows: Map<string, StellaStoreRows | undefined | Error>;
  files: Set<string>;
  runs: StellaRunRecord[];
  saved: string | undefined;
  loadThrows: boolean;
  sent: LocalMemoryEntry[];
  failSends: boolean;
  noted: MemoryRead[];
  queueSize: number;
  reads: Array<[string, number]>;
  lines: string[];
}

function fixture(over: Partial<Fixture> = {}): Fixture {
  return {
    rows: new Map(),
    files: new Set([STORE]),
    runs: RUNS,
    saved: undefined,
    loadThrows: false,
    sent: [],
    failSends: false,
    noted: [],
    queueSize: 0,
    reads: [],
    lines: [],
    ...over,
  };
}

/** A scanner over `f`, reading each store's rows past its cursor. */
function scanner(f: Fixture) {
  return createStellaMemories({
    runs: () => f.runs,
    exists: async (path) => f.files.has(path),
    read: (path, afterSeq, limit) => {
      f.reads.push([path, afterSeq]);
      const rows = f.rows.get(path);
      if (rows instanceof Error) throw rows;
      if (rows === undefined) return undefined;
      return {
        memories: rows.memories,
        uses: rows.uses
          .filter((row) => (row["seq"] as number) > afterSeq)
          .slice(0, limit),
      };
    },
    storage: {
      load: () => {
        if (f.loadThrows) throw new Error("EACCES");
        return f.saved === undefined ? undefined : JSON.parse(f.saved);
      },
      save: (json) => {
        f.saved = json;
      },
    },
    send: async (entry) => {
      if (f.failSends)
        throw new Error("memory upload: the control plane answered 429");
      f.sent.push(entry);
    },
    uses: {
      note: (read) => {
        if (f.queueSize >= MEMORY_USES_QUEUED_MAX) return false;
        f.noted.push(read);
        return true;
      },
      size: () => f.queueSize,
    },
    log: (line) => f.lines.push(line),
    now: () => NOW,
  });
}

const cursorOf = (f: Fixture, store = STORE) =>
  (JSON.parse(f.saved ?? "{}") as { stores?: Record<string, number> }).stores?.[
    store
  ];

describe("the Stella scanner", () => {
  it("sends each live memory once, with its lineage as its path", async () => {
    const f = fixture({
      rows: new Map([[STORE, { memories: [memoryRow("mem_a")], uses: [] }]]),
    });
    const stella = scanner(f);
    await expect(stella.scan()).resolves.toEqual({ sent: 1, cited: 0 });
    expect(f.sent).toEqual([
      {
        harness: "stella",
        path: "mem_a",
        statement: "text of mem_a",
        contentDigest: digestBytes("text of mem_a"),
        modifiedAt: "2026-08-01T00:00:00.000Z",
        memoryType: "reflection",
      },
    ]);
    await expect(stella.scan()).resolves.toEqual({ sent: 0, cited: 0 });
    // An edit in Stella sends the new text.
    f.rows.set(STORE, { memories: [memoryRow("mem_a", "new text")], uses: [] });
    await expect(stella.scan()).resolves.toEqual({ sent: 1, cited: 0 });
    expect(f.sent[1]?.statement).toBe("new text");
  });

  it("sends a memory again when it comes back after Stella forgot it", async () => {
    const f = fixture({
      rows: new Map([[STORE, { memories: [memoryRow("mem_a")], uses: [] }]]),
    });
    const stella = scanner(f);
    await stella.scan();
    f.rows.set(STORE, { memories: [], uses: [] });
    await stella.scan();
    f.rows.set(STORE, { memories: [memoryRow("mem_a")], uses: [] });
    await expect(stella.scan()).resolves.toEqual({ sent: 1, cited: 0 });
  });

  it("queues each use of a sent memory as a citation of its run, and saves the cursor", async () => {
    const f = fixture({
      rows: new Map([
        [
          STORE,
          {
            memories: [memoryRow("mem_a")],
            uses: [
              useRow(3, "mem_a"),
              useRow(5, "mem_a", { used_at: "2026-09-21T14:55:00Z" }),
            ],
          },
        ],
      ]),
    });
    await expect(scanner(f).scan()).resolves.toEqual({ sent: 1, cited: 2 });
    expect(f.noted).toEqual([
      {
        harness: "stella",
        path: "mem_a",
        sessionUuid: RUN,
        at: "2026-09-21T14:30:00.000Z",
        signal: "citation",
      },
      {
        harness: "stella",
        path: "mem_a",
        sessionUuid: RUN,
        at: "2026-09-21T14:55:00.000Z",
        signal: "citation",
      },
    ]);
    expect(JSON.parse(f.saved ?? "{}")).toEqual({
      schema: STELLA_CURSORS_STATE_SCHEMA,
      stores: { [STORE]: 5 },
    });
  });

  it("counts no use twice across a restart", async () => {
    const f = fixture({
      rows: new Map([
        [STORE, { memories: [memoryRow("mem_a")], uses: [useRow(3, "mem_a")] }],
      ]),
    });
    await scanner(f).scan();
    expect(f.noted).toHaveLength(1);
    // A new daemon reads on from the saved cursor, and sends the memory
    // again, since what it sent before is not saved.
    await expect(scanner(f).scan()).resolves.toEqual({ sent: 1, cited: 0 });
    expect(f.reads.at(-1)).toEqual([STORE, 3]);
    expect(f.noted).toHaveLength(1);
  });

  it("drops a use no run fits, and reads past it", async () => {
    const f = fixture({
      rows: new Map([
        [
          STORE,
          {
            memories: [memoryRow("mem_a")],
            uses: [
              useRow(1, "mem_a", { thread_id: "ses-1790000000000-7" }),
              useRow(2, "mem_a", { thread_id: null }),
              useRow(4, "mem_a", { used_at: "2026-09-20T00:00:00Z" }),
            ],
          },
        ],
      ]),
    });
    await expect(scanner(f).scan()).resolves.toEqual({ sent: 1, cited: 0 });
    expect(cursorOf(f)).toBe(4);
  });

  it("passes over a row it cannot read", async () => {
    const f = fixture({
      rows: new Map([
        [
          STORE,
          {
            memories: [memoryRow("mem_a")],
            uses: [
              useRow(2, "mem_a", { used_at: "never" }),
              useRow(3, "mem_a"),
            ],
          },
        ],
      ]),
    });
    await expect(scanner(f).scan()).resolves.toEqual({ sent: 1, cited: 1 });
    expect(cursorOf(f)).toBe(3);
  });

  it("holds the cursor at a use whose memory is not sent yet", async () => {
    const f = fixture({
      failSends: true,
      rows: new Map([
        [
          STORE,
          {
            memories: [memoryRow("mem_a")],
            uses: [useRow(3, "mem_a")],
          },
        ],
      ]),
    });
    const stella = scanner(f);
    await expect(stella.scan()).resolves.toEqual({ sent: 0, cited: 0 });
    expect(cursorOf(f)).toBe(0);
    f.failSends = false;
    await expect(stella.scan()).resolves.toEqual({ sent: 1, cited: 1 });
    expect(cursorOf(f)).toBe(3);
  });

  it("counts a use of a memory Stella no longer holds live", async () => {
    const f = fixture({
      rows: new Map([[STORE, { memories: [], uses: [useRow(3, "mem_gone")] }]]),
    });
    await expect(scanner(f).scan()).resolves.toEqual({ sent: 0, cited: 1 });
  });

  it("holds the cursor while the use queue is full", async () => {
    const f = fixture({
      queueSize: MEMORY_USES_QUEUED_MAX,
      rows: new Map([
        [STORE, { memories: [memoryRow("mem_a")], uses: [useRow(3, "mem_a")] }],
      ]),
    });
    const stella = scanner(f);
    await expect(stella.scan()).resolves.toEqual({ sent: 1, cited: 0 });
    expect(cursorOf(f)).toBe(0);
    f.queueSize = 0;
    await expect(stella.scan()).resolves.toEqual({ sent: 0, cited: 1 });
    expect(cursorOf(f)).toBe(3);
  });

  it("keeps reading a store after its runs leave the registry", async () => {
    const f = fixture({
      rows: new Map([[STORE, { memories: [], uses: [] }]]),
    });
    await scanner(f).scan();
    f.runs = [];
    await scanner(f).scan();
    expect(f.reads.map(([path]) => path)).toEqual([STORE, STORE]);
  });

  it("forgets a store that is gone", async () => {
    const f = fixture({
      rows: new Map([[STORE, { memories: [memoryRow("mem_a")], uses: [] }]]),
    });
    const stella = scanner(f);
    await stella.scan();
    f.files.clear();
    f.runs = [];
    await stella.scan();
    expect(f.reads).toHaveLength(1);
    expect(JSON.parse(f.saved ?? "{}").stores).toEqual({});
  });

  it("finds one store for two runs in the same workspace", async () => {
    const f = fixture({
      runs: [
        RUNS[0]!,
        { ...RUNS[0]!, sessionUuid: RUN, dirs: [APP, join(APP, "docs")] },
      ],
      rows: new Map([[STORE, { memories: [], uses: [] }]]),
    });
    await scanner(f).scan();
    expect(f.reads).toEqual([[STORE, 0]]);
  });

  it("skips a store with no export views, and says so once", async () => {
    const f = fixture({ rows: new Map([[STORE, undefined]]) });
    const stella = scanner(f);
    await stella.scan();
    await stella.scan();
    expect(f.sent).toEqual([]);
    expect(f.saved).toBeUndefined();
    expect(f.lines).toEqual([
      `stella memories: ${STORE} has no export views; they arrive when a Stella with context schema 14 or later opens the workspace`,
    ]);
  });

  it("logs a store it cannot read once each time the failure changes", async () => {
    const f = fixture({
      rows: new Map([[STORE, new Error("database is locked")]]),
    });
    const stella = scanner(f);
    await stella.scan();
    await stella.scan();
    f.rows.set(STORE, new Error("file is not a database"));
    await stella.scan();
    expect(f.lines).toEqual([
      `stella memories: ${STORE} could not be read (database is locked); its memories wait for the next scan`,
      `stella memories: ${STORE} could not be read (file is not a database); its memories wait for the next scan`,
    ]);
  });

  it("counts no use while the saved cursors cannot be read, and still sends memories", async () => {
    const f = fixture({
      loadThrows: true,
      rows: new Map([
        [STORE, { memories: [memoryRow("mem_a")], uses: [useRow(3, "mem_a")] }],
      ]),
    });
    await expect(scanner(f).scan()).resolves.toEqual({ sent: 1, cited: 0 });
    expect(f.lines).toEqual([
      "stella memories: the saved cursors could not be read (EACCES); no Stella use is counted until the daemon restarts",
    ]);
  });

  it("joins a scan still running", async () => {
    const f = fixture({
      rows: new Map([[STORE, { memories: [memoryRow("mem_a")], uses: [] }]]),
    });
    const stella = scanner(f);
    const first = stella.scan();
    expect(stella.scan()).toBe(first);
    await first;
    expect(f.sent).toHaveLength(1);
  });
});

describe("the Stella runs in the registry", () => {
  const session = (over: Record<string, unknown> = {}) => ({
    harness: "stella",
    pid: 4242,
    cwd: APP,
    workDir: join(APP, "src"),
    startedAt: "2026-09-21T14:13:21.000Z",
    lastSeenAt: "2026-09-21T15:00:00.000Z",
    sealed: true,
    recorder: { rootSessionUuid: RUN },
    ...over,
  });

  it("are the Stella sessions with their folders, and no other harness or custom agent", () => {
    expect(
      stellaRunsOf([
        session(),
        session({ harness: "claude-code" }),
        session({ customAgent: "reviewer" }),
        session({ pid: undefined, cwd: undefined, workDir: "" }),
      ]),
    ).toEqual([
      {
        pid: 4242,
        startedAt: "2026-09-21T14:13:21.000Z",
        lastSeenAt: "2026-09-21T15:00:00.000Z",
        sealed: true,
        sessionUuid: RUN,
        dirs: [APP, join(APP, "src")],
      },
      {
        startedAt: "2026-09-21T14:13:21.000Z",
        lastSeenAt: "2026-09-21T15:00:00.000Z",
        sealed: true,
        sessionUuid: RUN,
        dirs: [],
      },
    ]);
  });
});
