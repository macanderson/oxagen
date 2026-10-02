/**
 * Stella's context store (`stella-store.ts`) against a fixture database
 * built here with `node:sqlite`. The fixture carries the tables the export
 * views read and the views exactly as Stella's schema version 14 creates
 * them. The last block runs the store through the Stella scanner and the use
 * queue, as the daemon does.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../../host/control-client";
import type { LocalMemoryEntry } from "./memory-reader";
import { createMemoryUses } from "./memory-uses";
import { createStellaMemories } from "./stella-memories";
import {
  queryStellaStore,
  STELLA_CONTEXT_DB,
  STELLA_RUN_SLACK_MS,
  type StellaRun,
  stellaMemoryOf,
  stellaRunOf,
  stellaStoreOf,
  stellaThreadOf,
  stellaUseOf,
} from "./stella-store";

// A static import of `node:sqlite` loses its prefix under vite-node.
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

/** The columns of Stella's tables that the export views read. */
const TABLES = `
CREATE TABLE node (
    id            INTEGER PRIMARY KEY,
    public_id     TEXT NOT NULL UNIQUE,
    kind          TEXT NOT NULL,
    uri           TEXT,
    superseded_at TEXT
);
CREATE TABLE memory (
    id            INTEGER PRIMARY KEY,
    public_id     TEXT NOT NULL UNIQUE,
    kind          TEXT NOT NULL,
    content       TEXT NOT NULL,
    recorded_at   TEXT NOT NULL,
    lineage_id    TEXT,
    superseded_at TEXT
);
CREATE TABLE context_records (
    record_id      TEXT PRIMARY KEY,
    lineage_id     TEXT NOT NULL,
    record_kind    TEXT NOT NULL,
    record_hash    TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    body           TEXT NOT NULL,
    observed_at    TEXT NOT NULL,
    recorded_at    TEXT NOT NULL,
    supersedes     TEXT
);`;

/**
 * The views as Stella creates them (`MIGRATION_V14` in
 * `crates/stella-context/src/store/schema.rs`), copied word for word.
 */
const VIEWS = `
CREATE VIEW IF NOT EXISTS export_memories_v1 AS
SELECT m.lineage_id  AS lineage,
       m.public_id   AS revision,
       m.kind        AS kind,
       m.content     AS content,
       m.recorded_at AS recorded_at
  FROM memory m
 WHERE m.superseded_at IS NULL
   AND EXISTS (
         SELECT 1 FROM node n
          WHERE n.uri = 'memory://' || m.lineage_id
            AND n.kind = 'memory'
            AND n.superseded_at IS NULL);

CREATE VIEW IF NOT EXISTS export_memory_uses_v1 AS
SELECT r.rowid     AS seq,
       r.record_id AS use_id,
       substr(n.uri, length('memory://') + 1) AS lineage,
       json_extract(r.body, '$.use_kind') AS use_kind,
       CASE WHEN json_extract(r.body, '$.task_id') GLOB 'session:?*'
            THEN substr(json_extract(r.body, '$.task_id'), length('session:') + 1)
       END AS thread_id,
       CASE WHEN json_extract(r.body, '$.use_trace_id') GLOB 'ut_[0-9]*'
            THEN CAST(substr(json_extract(r.body, '$.use_trace_id'), length('ut_') + 1) AS INTEGER)
       END AS execution_id,
       COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', r.observed_at), r.observed_at) AS used_at
  FROM context_records r
  JOIN node n
    ON n.public_id = json_extract(r.body, '$.context_record_id')
   AND n.kind = 'memory'
   AND n.uri GLOB 'memory://?*'
 WHERE r.record_kind = 'context_use';`;

const THREAD = "ses-1790000000000-4242";
const RUN = "0b3f8a52-8d2c-4f0e-9a49-6f1c2d3e4a5b";
const OTHER_RUN = "1c4f9b63-9e3d-4a1f-8b5a-7a2d3e4f5b6c";
/** When the thread started: 2026-09-21T14:13:20Z. */
const THREAD_START = 1_790_000_000_000;

/** A Stella workspace whose context store holds the fixture rows. */
function fixtureWorkspace(options: { views?: boolean } = {}): {
  root: string;
  path: string;
} {
  const root = mkdtempSync(join(tmpdir(), "tacho-stella-"));
  const path = join(root, STELLA_CONTEXT_DB);
  mkdirSync(join(root, ".stella", "private"), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(TABLES);
  if (options.views ?? true) db.exec(VIEWS);
  const node = db.prepare(
    "INSERT INTO node (public_id, kind, uri, superseded_at) VALUES (?, ?, ?, ?)",
  );
  node.run("nod_kept", "memory", "memory://mem_kept", null);
  node.run(
    "nod_forgot",
    "memory",
    "memory://mem_forgot",
    "2026-09-20T00:00:00Z",
  );
  node.run("nod_blank", "memory", "memory://mem_blank", null);
  node.run("nod_episode", "episode", "episode://epi_1", null);
  const memory = db.prepare(
    "INSERT INTO memory (public_id, kind, content, recorded_at, lineage_id, superseded_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  memory.run(
    "mem_kept",
    "reflection",
    "prefer rg over grep",
    "2026-07-29T23:45:43Z",
    "mem_kept",
    "2026-08-01T00:00:00Z",
  );
  memory.run(
    "mem_kept_r2",
    "reflection",
    "  prefer rg over grep, and fd over find  ",
    "2026-08-01T00:00:00Z",
    "mem_kept",
    null,
  );
  memory.run(
    "mem_forgot",
    "reflection",
    "keep commits small",
    "2026-07-30T00:00:00Z",
    "mem_forgot",
    null,
  );
  memory.run(
    "mem_blank",
    "Reflection",
    "   ",
    "2026-07-30T00:00:00Z",
    "mem_blank",
    null,
  );
  const record = db.prepare(
    "INSERT INTO context_records (record_id, lineage_id, record_kind, record_hash, schema_version, body, observed_at, recorded_at) VALUES (?, ?, ?, 'sha256:x', '1', ?, ?, '2026-09-21T15:00:00Z')",
  );
  const use = (
    id: string,
    recordId: string,
    trace: string,
    task: string,
    at: string,
    kind = "context_use",
  ) =>
    record.run(
      id,
      id,
      kind,
      JSON.stringify({
        use_kind: "rendered",
        context_record_id: recordId,
        use_trace_id: trace,
        task_id: task,
        influence_stage: "none",
        observed_at: at,
      }),
      at,
    );
  use("cu_one", "nod_kept", "ut_7", `session:${THREAD}`, "2026-09-21 14:30:00");
  use("cu_two", "nod_forgot", "ut_8", "execution:8", "2026-09-21T14:40:00Z");
  use(
    "cu_three",
    "^ctx-small-commits",
    "ut_9",
    `session:${THREAD}`,
    "2026-09-21T14:50:00Z",
  );
  use(
    "cu_four",
    "nod_episode",
    "ut_9",
    `session:${THREAD}`,
    "2026-09-21T14:50:00Z",
  );
  use(
    "obs_one",
    "nod_kept",
    "ut_9",
    `session:${THREAD}`,
    "2026-09-21T14:50:00Z",
    "observation",
  );
  use(
    "cu_five",
    "nod_kept",
    "ut_10",
    `session:${THREAD}`,
    "2026-09-21 14:55:00",
  );
  db.close();
  return { root, path };
}

describe("a Stella context store", () => {
  it("returns each live memory and each memory use past the cursor", () => {
    const { path } = fixtureWorkspace();
    const rows = queryStellaStore(path, 0, 100);
    expect(rows?.memories.map((row) => row["lineage"])).toEqual([
      "mem_blank",
      "mem_kept",
    ]);
    expect(
      rows?.uses.map((row) => [
        row["lineage"],
        row["thread_id"],
        row["used_at"],
      ]),
    ).toEqual([
      ["mem_kept", THREAD, "2026-09-21T14:30:00Z"],
      ["mem_forgot", null, "2026-09-21T14:40:00Z"],
      ["mem_kept", THREAD, "2026-09-21T14:55:00Z"],
    ]);
    const first = rows?.uses[0]?.["seq"] as number;
    expect(
      queryStellaStore(path, first, 100)?.uses.map((row) => row["seq"]),
    ).toEqual(rows?.uses.slice(1).map((row) => row["seq"]));
    expect(queryStellaStore(path, 0, 1)?.uses).toHaveLength(1);
  });

  it("answers nothing for a store a Stella older than schema 14 last opened", () => {
    const { path } = fixtureWorkspace({ views: false });
    expect(queryStellaStore(path, 0, 100)).toBeUndefined();
  });

  it("throws for a store that is not there", () => {
    const root = mkdtempSync(join(tmpdir(), "tacho-stella-"));
    expect(() =>
      queryStellaStore(join(root, STELLA_CONTEXT_DB), 0, 100),
    ).toThrow();
  });
});

describe("a Stella memory row", () => {
  it("is a memory with its trimmed text, its kind as its type, and its time", () => {
    expect(
      stellaMemoryOf({
        lineage: "mem_kept",
        kind: "Reflection",
        content: "  prefer rg  ",
        recorded_at: "2026-08-01T00:00:00Z",
      }),
    ).toEqual({
      lineage: "mem_kept",
      statement: "prefer rg",
      memoryType: "reflection",
      recordedAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("is clipped to the statement limit", () => {
    const memory = stellaMemoryOf({
      lineage: "mem_long",
      kind: "reflection",
      content: "x".repeat(3_000),
      recorded_at: "2026-08-01T00:00:00Z",
    });
    expect(memory?.statement).toHaveLength(2_000);
  });

  it("leaves out a kind that does not read as a type", () => {
    expect(
      stellaMemoryOf({
        lineage: "mem_a",
        kind: "not a type!",
        content: "text",
        recorded_at: "bad",
      }),
    ).toEqual({
      lineage: "mem_a",
      statement: "text",
      recordedAt: new Date(0).toISOString(),
    });
  });

  it("is no memory without a lineage or without text", () => {
    for (const row of [
      { lineage: "", content: "text" },
      { lineage: "l".repeat(1_025), content: "text" },
      { lineage: 7, content: "text" },
      { lineage: "mem_a", content: "   " },
      { lineage: "mem_a", content: null },
    ])
      expect(stellaMemoryOf(row), JSON.stringify(row)).toBeUndefined();
  });
});

describe("a Stella use row", () => {
  it("is a use with its seq, lineage, thread, and time", () => {
    expect(
      stellaUseOf({
        seq: 21,
        lineage: "mem_kept",
        thread_id: THREAD,
        used_at: "2026-09-21T14:30:00Z",
      }),
    ).toEqual({
      seq: 21,
      lineage: "mem_kept",
      threadId: THREAD,
      usedAt: "2026-09-21T14:30:00.000Z",
    });
    expect(
      stellaUseOf({
        seq: 22,
        lineage: "mem_kept",
        thread_id: null,
        used_at: "2026-09-21T14:30:00Z",
      }),
    ).not.toHaveProperty("threadId");
  });

  it("is no use without a seq, a lineage, or a time", () => {
    for (const row of [
      { seq: 0, lineage: "mem_a", used_at: "2026-09-21T14:30:00Z" },
      { seq: 1.5, lineage: "mem_a", used_at: "2026-09-21T14:30:00Z" },
      { seq: 1, lineage: null, used_at: "2026-09-21T14:30:00Z" },
      { seq: 1, lineage: "mem_a", used_at: "yesterday" },
    ])
      expect(stellaUseOf(row), JSON.stringify(row)).toBeUndefined();
  });
});

describe("a Stella thread id", () => {
  it("names the thread's start and its process", () => {
    expect(stellaThreadOf("ses-1789972711780-21683")).toEqual({
      startedMs: 1_789_972_711_780,
      pid: 21_683,
    });
    expect(stellaThreadOf("ses-1789972711780-21683__req-3")).toEqual({
      startedMs: 1_789_972_711_780,
      pid: 21_683,
    });
  });

  it("is nothing in another shape", () => {
    for (const id of [
      "drive-1790000000-00ab-0001",
      "ses-1-0",
      "ses--1",
      "ses-1-2x",
    ])
      expect(stellaThreadOf(id), id).toBeUndefined();
  });
});

describe("the run of a Stella use", () => {
  const at = (ms: number) => new Date(ms).toISOString();
  const run = (over: Partial<StellaRun> = {}): StellaRun => ({
    pid: 4242,
    startedAt: at(THREAD_START + 2_000),
    lastSeenAt: at(THREAD_START + 60 * 60_000),
    sealed: true,
    sessionUuid: RUN,
    ...over,
  });
  /** A use at `ms` in `threadId`, or in no thread when it is null. */
  const use = (ms: number, threadId: string | null = THREAD) => ({
    seq: 1,
    lineage: "mem_kept",
    ...(threadId !== null ? { threadId } : {}),
    usedAt: at(ms),
  });
  const NOW = THREAD_START + 10 * 60 * 60_000;

  it("is the run of the thread's process whose hooks span the use", () => {
    expect(stellaRunOf(use(THREAD_START + 30 * 60_000), [run()], NOW)).toBe(
      RUN,
    );
  });

  it("runs to now while the run is live", () => {
    expect(
      stellaRunOf(
        use(THREAD_START + 5 * 60 * 60_000),
        [run({ sealed: false })],
        NOW,
      ),
    ).toBe(RUN);
  });

  it("takes a use just outside the run's hooks when no other run is near", () => {
    expect(
      stellaRunOf(
        use(THREAD_START + 60 * 60_000 + STELLA_RUN_SLACK_MS - 1_000),
        [run()],
        NOW,
      ),
    ).toBe(RUN);
  });

  it("is no run for another process, a use far from the run, or a use with no thread", () => {
    expect(
      stellaRunOf(use(THREAD_START + 30 * 60_000), [run({ pid: 7 })], NOW),
    ).toBeUndefined();
    expect(
      stellaRunOf(
        use(THREAD_START + 30 * 60_000),
        [run({ pid: undefined })],
        NOW,
      ),
    ).toBeUndefined();
    expect(
      stellaRunOf(use(THREAD_START + 3 * 60 * 60_000), [run()], NOW),
    ).toBeUndefined();
    expect(stellaRunOf(use(THREAD_START, null), [run()], NOW)).toBeUndefined();
    expect(
      stellaRunOf(use(THREAD_START, "drive-1-2-3"), [run()], NOW),
    ).toBeUndefined();
  });

  it("passes over a run of the same pid that ended before the thread began", () => {
    const earlier = run({
      startedAt: at(THREAD_START - 3 * 60 * 60_000),
      lastSeenAt: at(THREAD_START - 2 * 60 * 60_000),
      sessionUuid: OTHER_RUN,
    });
    expect(
      stellaRunOf(use(THREAD_START + 30 * 60_000), [earlier, run()], NOW),
    ).toBe(RUN);
  });

  it("prefers the run whose hooks hold the use over one that is only near it", () => {
    const next = run({
      startedAt: at(THREAD_START + 61 * 60_000),
      lastSeenAt: at(THREAD_START + 2 * 60 * 60_000),
      sessionUuid: OTHER_RUN,
    });
    expect(
      stellaRunOf(use(THREAD_START + 62 * 60_000), [run(), next], NOW),
    ).toBe(OTHER_RUN);
  });

  it("is no run when two runs are only near the use", () => {
    const next = run({
      startedAt: at(THREAD_START + 64 * 60_000),
      lastSeenAt: at(THREAD_START + 2 * 60 * 60_000),
      sessionUuid: OTHER_RUN,
    });
    expect(
      stellaRunOf(use(THREAD_START + 62 * 60_000), [run(), next], NOW),
    ).toBeUndefined();
  });
});

describe("the context store of a folder", () => {
  const exists = (paths: string[]) => async (path: string) =>
    paths.includes(path);

  it("is the nearest .stella/private/context.db at or above the folder", async () => {
    const store = join("/work/app", STELLA_CONTEXT_DB);
    expect(await stellaStoreOf("/work/app/src/lib", exists([store]))).toBe(
      store,
    );
    expect(await stellaStoreOf("/work/app", exists([store]))).toBe(store);
    const inner = join("/work/app/src", STELLA_CONTEXT_DB);
    expect(
      await stellaStoreOf("/work/app/src/lib", exists([store, inner])),
    ).toBe(inner);
  });

  it("is none when no folder above holds one, or for a relative folder", async () => {
    expect(await stellaStoreOf("/work/app", exists([]))).toBeUndefined();
    expect(
      await stellaStoreOf(
        "work/app",
        exists([join("work/app", STELLA_CONTEXT_DB)]),
      ),
    ).toBeUndefined();
  });
});

describe("a Stella store through the scanner and the use queue", () => {
  it("sends the live memories, then each use of a sent memory as a citation of its run", async () => {
    const { root, path } = fixtureWorkspace();
    const sent: LocalMemoryEntry[] = [];
    const bodies: unknown[] = [];
    const fetch: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init.body ?? "null"));
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ recorded: 1, unknown: 0, pending: [], retired: 0 }),
      };
    };
    const now = () => Date.parse("2026-09-21T16:00:00Z");
    const uses = createMemoryUses({
      host: () => ({
        api_url: "https://api.oxagen.test",
        api_key: "oxk_host",
        host_enrollment_id: "tch_0123456789abcdefghjkmn",
      }),
      fetch,
      log: () => {},
      now,
    });
    let saved: string | undefined;
    const stella = createStellaMemories({
      runs: () => [
        {
          pid: 4242,
          startedAt: "2026-09-21T14:13:21.000Z",
          lastSeenAt: "2026-09-21T15:00:00.000Z",
          sealed: true,
          sessionUuid: RUN,
          dirs: [join(root, "src")],
        },
      ],
      exists: async (file) => file === path,
      storage: {
        load: () => undefined,
        save: (json) => {
          saved = json;
        },
      },
      send: async (entry) => {
        sent.push(entry);
      },
      uses,
      log: () => {},
      now,
    });

    await expect(stella.scan()).resolves.toEqual({ sent: 1, cited: 2 });
    expect(
      sent.map((entry) => [entry.harness, entry.path, entry.statement]),
    ).toEqual([
      ["stella", "mem_kept", "prefer rg over grep, and fd over find"],
    ]);
    await uses.report();
    expect(bodies).toEqual([
      {
        host_enrollment_id: "tch_0123456789abcdefghjkmn",
        uses: [
          {
            harness: "stella",
            path: "mem_kept",
            signal: "citation",
            session_uuid: RUN,
            count: 2,
            used_at: "2026-09-21T14:55:00.000Z",
          },
        ],
      },
    ]);
    // The use of the forgotten memory has no thread, so no run, and the
    // cursor passed it with the rest.
    expect(JSON.parse(saved ?? "{}").stores[path]).toBeGreaterThan(0);
    await expect(stella.scan()).resolves.toEqual({ sent: 0, cited: 0 });
  });
});
