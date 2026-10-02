/**
 * Codex's memory store (`codex-store.ts`) against a fixture database built
 * here with `node:sqlite`, in the shape Codex writes: which rows become
 * memories, what each one's statement and count are, and what a missing,
 * broken, or unexpected store does. The last block runs the store through
 * the memory reader and the use count ledger, as the daemon does.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestBytes } from "../../digest";
import {
  CODEX_MEMORY_ROOT,
  CODEX_MEMORY_STORE_FILE,
  codexMemoryOf,
  codexStatementOf,
  createCodexMemoryStore,
} from "./codex-store";
import { createUseCountLedger } from "./memory-counts";
import { createMemoryReader, type LocalMemoryEntry } from "./memory-reader";

// A static import of `node:sqlite` loses its prefix under vite-node.
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

/** The table as Codex's migrations create it (`~/.codex/memories_1.sqlite`). */
const SCHEMA = `
CREATE TABLE stage1_outputs (
    thread_id TEXT PRIMARY KEY,
    source_updated_at INTEGER NOT NULL,
    raw_memory TEXT NOT NULL,
    rollout_summary TEXT NOT NULL,
    rollout_slug TEXT,
    generated_at INTEGER NOT NULL,
    usage_count INTEGER,
    last_usage INTEGER,
    selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
    selected_for_phase2_source_updated_at INTEGER
);`;

/** Epoch seconds, as Codex stores its times. */
const GENERATED = 1_790_627_482;
const LAST_USE = 1_790_741_856;

/** A row with the bare key block Codex writes for most memories. */
const BARE = [
  "description: Use precise date-bounded counts without unsupported rankings",
  " task: app-copy-simplification",
  " task_group: /Users/dev/Projects/app",
  " task_outcome: partial",
  "",
  "### Task 1: Simplify app copy",
  "",
  "description: a line in the body, not the statement",
].join("\n");

/** A row whose key block sits between `---` rules. */
const FENCED = [
  "---",
  "description: Coordinated PR conflict repair and CI verification.",
  "task: dispatch-agents-resolve-pr-conflicts",
  "cwd: /Users/dev/Projects/oxagen",
  "---",
  "",
  "### Task 1: Dispatch and triage active PRs",
].join("\n");

interface FixtureRow {
  thread_id: string;
  raw_memory: string;
  rollout_slug?: string | null;
  usage_count?: number | null;
  last_usage?: number | null;
}

/** A Codex home with a store holding `rows`, and the store's path. */
function fixtureStore(rows: readonly FixtureRow[]): string {
  const dir = mkdtempSync(join(tmpdir(), "tacho-codex-"));
  const path = join(dir, CODEX_MEMORY_STORE_FILE);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  const insert = db.prepare(
    "INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at, usage_count, last_usage) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of rows)
    insert.run(
      row.thread_id,
      GENERATED - 60,
      row.raw_memory,
      "# Summary",
      row.rollout_slug ?? null,
      GENERATED,
      row.usage_count ?? null,
      row.last_usage ?? null,
    );
  db.close();
  return path;
}

/** Codex's own rows from one machine, cut to what the reader reads. */
const ROWS: FixtureRow[] = [
  {
    thread_id: "01a0e198-36ea-7e52-aedf-4b346877c10d",
    raw_memory: BARE,
    rollout_slug: "simplify-app-copy",
    usage_count: 4,
    last_usage: LAST_USE,
  },
  {
    thread_id: "01a0bb72-a118-7871-9189-349180e1b360",
    raw_memory: FENCED,
    rollout_slug: null,
    usage_count: null,
    last_usage: null,
  },
  {
    thread_id: "01a0e9b6-6d62-7be1-b979-7508fef62bfc",
    raw_memory: "task: no description here\n\nbody",
    usage_count: 2,
  },
];

function store(path: string) {
  const lines: string[] = [];
  const codex = createCodexMemoryStore({
    path,
    stat: (file) => stat(file),
    log: (line) => lines.push(line),
  });
  return { codex, lines };
}

describe("a Codex row's statement", () => {
  it("is the description line of a bare key block", () => {
    expect(codexStatementOf(BARE)).toBe(
      "Use precise date-bounded counts without unsupported rankings",
    );
  });

  it("is the description line between --- rules", () => {
    expect(codexStatementOf(FENCED)).toBe(
      "Coordinated PR conflict repair and CI verification.",
    );
  });

  it("drops the quotes around a quoted description", () => {
    expect(codexStatementOf('---\ndescription: "Say: it works"\n---\n')).toBe(
      "Say: it works",
    );
    expect(codexStatementOf("description: 'It''s done'\n")).toBe("It's done");
  });

  it("is none when the key block has no description", () => {
    for (const raw of [
      "task: x\n\ndescription: only in the body",
      " description: indented under another key",
      "---\ntask: x\n---\ndescription: after the block",
      "description:   \ntask: x",
      "description: |\n  a block scalar",
      "",
    ])
      expect(codexStatementOf(raw), JSON.stringify(raw)).toBeUndefined();
  });

  it("reads past a byte-order mark and CRLF line ends", () => {
    expect(codexStatementOf("﻿---\r\ndescription: CRLF row\r\n---\r\n")).toBe(
      "CRLF row",
    );
  });
});

describe("a Codex row", () => {
  it("is a memory under thread/ with its slug as label and its count", () => {
    expect(
      codexMemoryOf({
        thread_id: "t1",
        raw_memory: BARE,
        rollout_slug: "simplify-app-copy",
        generated_at: GENERATED,
        usage_count: 4,
        last_usage: LAST_USE,
      }),
    ).toEqual({
      path: "thread/t1",
      statement: "Use precise date-bounded counts without unsupported rankings",
      label: "simplify-app-copy",
      modifiedAt: new Date(GENERATED * 1000).toISOString(),
      useCount: 4,
      lastUsedAt: new Date(LAST_USE * 1000).toISOString(),
    });
  });

  it("counts zero uses when Codex never used it", () => {
    const memory = codexMemoryOf({
      thread_id: "t1",
      raw_memory: FENCED,
      rollout_slug: null,
      generated_at: GENERATED,
      usage_count: null,
      last_usage: null,
    });
    expect(memory?.useCount).toBe(0);
    expect(memory).not.toHaveProperty("label");
    expect(memory).not.toHaveProperty("lastUsedAt");
  });

  it("leaves out a count that is not a whole number of uses", () => {
    for (const usage_count of [-1, 1.5, "3"])
      expect(
        codexMemoryOf({
          thread_id: "t1",
          raw_memory: FENCED,
          rollout_slug: null,
          generated_at: GENERATED,
          usage_count,
          last_usage: null,
        }),
      ).not.toHaveProperty("useCount");
  });

  it("is no memory without a thread id or a raw memory", () => {
    for (const patch of [
      { thread_id: "" },
      { thread_id: 7 },
      { thread_id: "t".repeat(513) },
      { raw_memory: null },
    ])
      expect(
        codexMemoryOf({
          thread_id: "t1",
          raw_memory: FENCED,
          rollout_slug: null,
          generated_at: GENERATED,
          usage_count: 1,
          last_usage: null,
          ...patch,
        }),
        JSON.stringify(patch),
      ).toBeUndefined();
  });
});

describe("the Codex store", () => {
  it("reads one memory for each row with a description, read-only", async () => {
    const path = fixtureStore(ROWS);
    const { codex, lines } = store(path);
    expect(codex.harness).toBe("codex");
    expect(codex.root).toBe(CODEX_MEMORY_ROOT);
    const read = await codex.read();
    expect(read).toEqual({
      kind: "read",
      // In thread order, so every scan sends in the same order.
      memories: [
        {
          path: "thread/01a0bb72-a118-7871-9189-349180e1b360",
          statement: "Coordinated PR conflict repair and CI verification.",
          modifiedAt: new Date(GENERATED * 1000).toISOString(),
          useCount: 0,
        },
        {
          path: "thread/01a0e198-36ea-7e52-aedf-4b346877c10d",
          statement:
            "Use precise date-bounded counts without unsupported rankings",
          label: "simplify-app-copy",
          modifiedAt: new Date(GENERATED * 1000).toISOString(),
          useCount: 4,
          lastUsedAt: new Date(LAST_USE * 1000).toISOString(),
        },
      ],
    });
    expect(lines).toEqual([]);
    // The read changed nothing in the store.
    const db = new DatabaseSync(path, { readOnly: true });
    expect(
      db.prepare("SELECT count(*) AS n FROM stage1_outputs").get(),
    ).toEqual({ n: 3 });
    db.close();
  });

  it("reads only the head of a long raw memory", async () => {
    const path = fixtureStore([
      {
        thread_id: "t1",
        raw_memory: `description: Long row\n\n${"x".repeat(100_000)}`,
        usage_count: 1,
      },
    ]);
    const read = await store(path).codex.read();
    expect(read.kind === "read" && read.memories[0]?.statement).toBe(
      "Long row",
    );
  });

  it("is missing when Codex keeps no store, and logs nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tacho-codex-"));
    const { codex, lines } = store(join(dir, CODEX_MEMORY_STORE_FILE));
    expect(await codex.read()).toEqual({ kind: "missing" });
    expect(lines).toEqual([]);
  });

  it("is unavailable when the file is no SQLite store, and logs that once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tacho-codex-"));
    const path = join(dir, CODEX_MEMORY_STORE_FILE);
    writeFileSync(path, "not a database, though long enough to have a header");
    const { codex, lines } = store(path);
    expect(await codex.read()).toEqual({ kind: "unavailable" });
    expect(await codex.read()).toEqual({ kind: "unavailable" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(path);
  });

  it("is unavailable when the store has no stage1_outputs table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tacho-codex-"));
    const path = join(dir, CODEX_MEMORY_STORE_FILE);
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE other (id INTEGER);");
    db.close();
    const { codex, lines } = store(path);
    expect(await codex.read()).toEqual({ kind: "unavailable" });
    expect(lines[0]).toContain("stage1_outputs");
  });

  it("logs a failure again after a read between", async () => {
    let fail = true;
    const lines: string[] = [];
    const codex = createCodexMemoryStore({
      path: "/codex/memories_1.sqlite",
      stat: async () => ({}),
      query: () => {
        if (fail) throw new Error("database is locked");
        return [];
      },
      log: (line) => lines.push(line),
    });
    await codex.read();
    fail = false;
    expect(await codex.read()).toEqual({ kind: "read", memories: [] });
    fail = true;
    await codex.read();
    expect(lines).toHaveLength(2);
  });

  it("is unavailable when the store's folder cannot be read", async () => {
    const codex = createCodexMemoryStore({
      path: "/codex/memories_1.sqlite",
      stat: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
      log: () => {},
    });
    expect(await codex.read()).toEqual({ kind: "unavailable" });
  });
});

describe("Codex memories through the reader", () => {
  it("sends one memory per row, and reports each rise in usage_count once", async () => {
    const path = fixtureStore(ROWS);
    const sent: LocalMemoryEntry[] = [];
    const reader = createMemoryReader({
      home: mkdtempSync(join(tmpdir(), "tacho-home-")),
      fs: {
        readdir: async () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
        stat: async () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
        readFile: async () => "",
      },
      send: async (entry) => {
        sent.push(entry);
      },
      stores: [store(path).codex],
    });
    let saved: string | undefined;
    const storage = {
      load: () => (saved === undefined ? undefined : JSON.parse(saved)),
      save: (json: string) => {
        saved = json;
      },
    };
    const ledger = () =>
      createUseCountLedger({ storage, log: () => {}, now: () => 0 });

    const first = await reader.scan();
    expect(sent.map((entry) => [entry.path, entry.statement])).toEqual([
      [
        "thread/01a0bb72-a118-7871-9189-349180e1b360",
        "Coordinated PR conflict repair and CI verification.",
      ],
      [
        "thread/01a0e198-36ea-7e52-aedf-4b346877c10d",
        "Use precise date-bounded counts without unsupported rankings",
      ],
    ]);
    expect(sent[1]?.contentDigest).toBe(
      digestBytes("Use precise date-bounded counts without unsupported rankings"),
    );
    expect(first.scans).toEqual([
      {
        harness: "codex",
        root: "thread/",
        paths: [
          "thread/01a0bb72-a118-7871-9189-349180e1b360",
          "thread/01a0e198-36ea-7e52-aedf-4b346877c10d",
        ],
      },
    ]);
    const counts = ledger();
    const rises = counts.rises(first.counts ?? []);
    expect(rises.map((rise) => [rise.path, rise.count])).toEqual([
      ["thread/01a0e198-36ea-7e52-aedf-4b346877c10d", 4],
    ]);
    counts.settle(rises);

    // Codex used the first memory twice more. The daemon restarts.
    const db = new DatabaseSync(path);
    db.exec(
      "UPDATE stage1_outputs SET usage_count = 6 WHERE thread_id = '01a0e198-36ea-7e52-aedf-4b346877c10d'",
    );
    db.close();
    const second = await reader.scan();
    expect(second.sent).toBe(0);
    expect(
      ledger()
        .rises(second.counts ?? [])
        .map((rise) => [rise.path, rise.count]),
    ).toEqual([["thread/01a0e198-36ea-7e52-aedf-4b346877c10d", 2]]);
  });
});
