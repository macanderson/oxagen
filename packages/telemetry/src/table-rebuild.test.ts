// table-rebuild.test.ts
//
// The rebuild's decisions, driven through every point a run can stop at.
// The store below keeps tables in memory, so each test can stop a run at any
// statement, before or after it takes effect, then run again and check what
// the table holds. The SQL each operation sends is proved against a real
// server in table-rebuild.integration.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import {
  clickhouseRebuildStore,
  engineWithKey,
  parseRebuildDirective,
  REBUILD_QUERY_SETTINGS,
  RebuildDirectiveError,
  rebuildPartitionKey,
  RebuildStateError,
  type RebuildStore,
  shadowTableName,
  type TableShape,
} from "./table-rebuild";

/** A row, by id, with the month of each of its two clocks. */
interface Row {
  id: string;
  ts: string;
  rec: string;
}

interface Table {
  key: string;
  engineFull: string;
  rows: Row[];
}

const OLD_KEY = "toYYYYMM(ts)";
const NEW_KEY = "toYYYYMM(received_at)";
const ENGINE = (key: string) =>
  `ReplacingMergeTree(received_at) PARTITION BY ${key} ORDER BY (org_id, seq) TTL toDateTime(received_at) + toIntervalMonth(13) SETTINGS index_granularity = 8192, min_bytes_for_wide_part = 67108864`;
const DIRECTIVE = {
  table: "events",
  partitionBy: NEW_KEY,
  column: "received_at",
};
const SHADOW = shadowTableName("events");

/** Where a run stops: before the nth statement takes effect, or just after. */
interface Stop {
  at: number;
  after: boolean;
}

class MemoryStore implements RebuildStore {
  tables = new Map<string, Table>();
  engine = "Atomic";
  statements: string[] = [];
  stop: Stop | null = null;
  /** Runs after each statement takes effect: writes that arrive meanwhile. */
  between: ((statement: string) => void) | null = null;
  /** How many settle polls report an insert still running. */
  running = 0;
  written = 0;
  /**
   * The server's month a day ago. Months here have no days, so the store
   * reads a month as the month a day before it.
   */
  month = "202609";

  constructor(rows: Row[]) {
    this.tables.set("events", {
      key: OLD_KEY,
      engineFull: ENGINE(OLD_KEY),
      rows,
    });
  }

  /** A write from ingest: it lands in whatever table has the live name now. */
  write(rec: string, into = "events"): Row {
    this.written += 1;
    const row = { id: `w${this.written}`, ts: "202601", rec };
    this.tables.get(into)?.rows.push(row);
    return row;
  }

  private run(statement: string, effect: () => void): void {
    this.statements.push(statement);
    const n = this.statements.length;
    if (this.stop?.at === n && !this.stop.after)
      throw new Error(`stopped before ${statement}`);
    effect();
    this.between?.(statement);
    if (this.stop?.at === n && this.stop.after)
      throw new Error(`stopped after ${statement}`);
  }

  private table(name: string): Table {
    const found = this.tables.get(name);
    if (found === undefined) throw new Error(`no table ${name}`);
    return found;
  }

  static partition(row: Row, key: string): string {
    return key.includes("received_at") ? row.rec : row.ts;
  }

  async shapes(names: readonly string[]) {
    const out = new Map<string, TableShape>();
    for (const name of names) {
      const t = this.tables.get(name);
      if (t !== undefined)
        out.set(name, { partitionKey: t.key, engineFull: t.engineFull });
    }
    return out;
  }
  async databaseEngine() {
    return this.engine;
  }
  async partitionRows(table: string, partitionBy: string) {
    const out = new Map<string, { rows: number; id: string }>();
    for (const row of this.table(table).rows) {
      const p = MemoryStore.partition(row, partitionBy);
      out.set(p, { rows: (out.get(p)?.rows ?? 0) + 1, id: p });
    }
    return out;
  }
  async createShadow(table: string, shadow: string, engine: string) {
    this.run(`create ${shadow}`, () => {
      if (this.tables.has(shadow)) return;
      this.table(table);
      const key = /PARTITION BY (\S+)/.exec(engine)?.[1] ?? "";
      this.tables.set(shadow, { key, engineFull: engine, rows: [] });
    });
  }
  async dropPartition(table: string, id: string) {
    this.run(`drop partition ${table} ${id}`, () => {
      const t = this.table(table);
      t.rows = t.rows.filter((r) => MemoryStore.partition(r, t.key) !== id);
    });
  }
  async copyPartition(
    from: string,
    to: string,
    partitionBy: string,
    partition: string,
  ) {
    this.run(`copy ${from} ${to} ${partition}`, () => {
      const rows = this.table(from).rows.filter(
        (r) => MemoryStore.partition(r, partitionBy) === partition,
      );
      this.table(to).rows.push(...rows.map((r) => ({ ...r })));
    });
  }
  async exchange(a: string, b: string) {
    this.run(`exchange ${a} ${b}`, () => {
      const ta = this.table(a);
      const tb = this.table(b);
      this.tables.set(a, tb);
      this.tables.set(b, ta);
    });
  }
  async drop(table: string) {
    this.run(`drop ${table}`, () => {
      this.tables.delete(table);
    });
  }
  async insertsRunningFor() {
    if (this.running === 0) return 0;
    this.running -= 1;
    return 1;
  }
  async monthBeforeNow() {
    return this.month;
  }
  async lastWriteMonth(table: string) {
    const months = this.table(table)
      .rows.map((r) => r.rec)
      .filter((rec) => rec <= this.month)
      .sort();
    return months.at(-1) ?? "000000";
  }
}

const quiet = { log: () => {}, sleep: async () => {} };

/** Rows across three producer months and two receive months. */
function seed(): Row[] {
  return [
    { id: "a", ts: "202607", rec: "202608" },
    { id: "b", ts: "202608", rec: "202608" },
    { id: "c", ts: "202609", rec: "202608" },
    { id: "d", ts: "202609", rec: "202609" },
    { id: "e", ts: "203001", rec: "202609" },
  ];
}

/** The row ids the live table holds, each once, as FINAL reads them. */
function liveIds(store: MemoryStore): string[] {
  return [
    ...new Set(store.tables.get("events")?.rows.map((r) => r.id) ?? []),
  ].sort();
}

/** The table is rebuilt: the new key, no shadow, every row once. */
function expectRebuilt(store: MemoryStore, ids: string[]) {
  expect(store.tables.get("events")?.key).toBe(NEW_KEY);
  expect(store.tables.get("events")?.engineFull).toBe(ENGINE(NEW_KEY));
  expect(store.tables.has(SHADOW)).toBe(false);
  expect(liveIds(store)).toEqual([...ids].sort());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseRebuildDirective", () => {
  it("reads a monthly key on one column", () => {
    expect(
      parseRebuildDirective(
        "REBUILD TABLE tacho_events\n  PARTITION BY toYYYYMM(received_at)",
      ),
    ).toEqual({
      table: "tacho_events",
      partitionBy: "toYYYYMM(received_at)",
      column: "received_at",
    });
    expect(
      parseRebuildDirective("rebuild table t partition by toYYYYMM(c)"),
    ).toEqual({ table: "t", partitionBy: "toYYYYMM(c)", column: "c" });
  });

  it("leaves every other statement to the server", () => {
    expect(parseRebuildDirective("ALTER TABLE t ADD COLUMN x UInt8")).toBe(
      null,
    );
    expect(parseRebuildDirective("REBUILDING t")).toBe(null);
  });

  it("refuses a key the copy's rule does not hold for", () => {
    expect(() =>
      parseRebuildDirective("REBUILD TABLE t PARTITION BY cityHash64(id) % 8"),
    ).toThrow(RebuildDirectiveError);
    expect(() => parseRebuildDirective("REBUILD TABLE t")).toThrow(
      /REBUILD TABLE <table> PARTITION BY toYYYYMM\(<column>\)/,
    );
  });
});

describe("engineWithKey", () => {
  it("replaces the key and keeps the TTL and settings", () => {
    expect(
      engineWithKey(
        { partitionKey: OLD_KEY, engineFull: ENGINE(OLD_KEY) },
        NEW_KEY,
        "events",
      ),
    ).toBe(ENGINE(NEW_KEY));
  });

  it("refuses an engine it cannot read one key out of", () => {
    const shape = (engineFull: string, partitionKey = OLD_KEY) => ({
      partitionKey,
      engineFull,
    });
    expect(() =>
      engineWithKey(shape("MergeTree ORDER BY id"), NEW_KEY, "t"),
    ).toThrow(RebuildStateError);
    expect(() =>
      engineWithKey(
        shape(`MergeTree PARTITION BY ${OLD_KEY} TTL PARTITION BY ${OLD_KEY}`),
        NEW_KEY,
        "t",
      ),
    ).toThrow(/one "PARTITION BY toYYYYMM\(ts\)"/);
    expect(() =>
      engineWithKey(shape("MergeTree ORDER BY id", ""), NEW_KEY, "t"),
    ).toThrow(RebuildStateError);
  });
});

describe("rebuildPartitionKey", () => {
  it("rebuilds a table partitioned by the producer's clock", async () => {
    const store = new MemoryStore(seed());
    await expect(rebuildPartitionKey(store, DIRECTIVE, quiet)).resolves.toBe(
      "rebuilt",
    );
    expectRebuilt(store, ["a", "b", "c", "d", "e"]);
    // One partition per receive month, whatever the producers' clocks said.
    const parts = await store.partitionRows("events", NEW_KEY);
    expect([...parts.keys()].sort()).toEqual(["202608", "202609"]);
  });

  it("does nothing to a table that already has the key", async () => {
    const store = new MemoryStore(seed());
    await rebuildPartitionKey(store, DIRECTIVE, quiet);
    const statements = store.statements.length;
    await expect(rebuildPartitionKey(store, DIRECTIVE, quiet)).resolves.toBe(
      "current",
    );
    expect(store.statements.length).toBe(statements);
  });

  it("copies one partition at a time and drops the old table", async () => {
    const store = new MemoryStore(seed());
    await rebuildPartitionKey(store, DIRECTIVE, quiet);
    expect(store.statements).toEqual([
      `create ${SHADOW}`,
      `copy events ${SHADOW} 202608`,
      `copy events ${SHADOW} 202609`,
      `exchange events ${SHADOW}`,
      // The months from the copy's start again, because writes reached them.
      // August's count in the new table shows it whole.
      `copy ${SHADOW} events 202609`,
      `drop ${SHADOW}`,
    ]);
  });

  // The replay property (#3698, #4297): a run can stop before or after any
  // statement, and the next run finishes the rebuild with every row in place.
  // Writes arrive throughout, as ingest keeps sending during a deploy.
  const statementCount = (() => {
    const store = new MemoryStore(seed());
    return rebuildPartitionKey(store, DIRECTIVE, quiet).then(
      () => store.statements.length,
    );
  })();

  for (const after of [false, true]) {
    it(`finishes a rebuild stopped ${after ? "after" : "before"} any statement`, async () => {
      const total = await statementCount;
      for (let at = 1; at <= total; at += 1) {
        const store = new MemoryStore(seed());
        const expected = seed().map((r) => r.id);
        store.between = (statement) => {
          // A write into the live table after every statement, and an insert
          // that began before the swap and lands in the old table after it.
          expected.push(store.write("202609").id);
          if (statement.startsWith("exchange"))
            expected.push(store.write("202609", SHADOW).id);
        };
        store.stop = { at, after };
        await expect(
          rebuildPartitionKey(store, DIRECTIVE, quiet),
        ).rejects.toThrow(/stopped/);
        store.stop = null;
        const outcome = await rebuildPartitionKey(store, DIRECTIVE, quiet);
        expect(["rebuilt", "resumed", "current"]).toContain(outcome);
        expectRebuilt(store, expected);
      }
    });
  }

  it("copies rows that reached a month after it was copied, across a month boundary", async () => {
    const store = new MemoryStore(seed());
    // The copy starts in August.
    store.month = "202608";
    const expected = seed().map((r) => r.id);
    store.between = (statement) => {
      // The copy crosses midnight on the first: late writes to August, then
      // September's first.
      if (statement === `copy events ${SHADOW} 202609`) {
        expected.push(store.write("202608").id);
        expected.push(store.write("202609").id);
      }
    };
    await rebuildPartitionKey(store, DIRECTIVE, quiet);
    expectRebuilt(store, expected);
  });

  it("copies a partition again only when the first copy is short", async () => {
    const store = new MemoryStore(seed());
    await store.createShadow(
      "events",
      SHADOW,
      engineWithKey(
        { partitionKey: OLD_KEY, engineFull: ENGINE(OLD_KEY) },
        NEW_KEY,
        "events",
      ),
    );
    // An earlier run copied August in full and September in part, and left a
    // month the source no longer holds (its rows have since expired).
    const shadow = store.tables.get(SHADOW) as Table;
    shadow.rows.push(
      { id: "a", ts: "202607", rec: "202608" },
      { id: "b", ts: "202608", rec: "202608" },
      { id: "c", ts: "202609", rec: "202608" },
      { id: "d", ts: "202609", rec: "202609" },
      { id: "x", ts: "202501", rec: "202501" },
    );
    store.statements = [];
    await rebuildPartitionKey(store, DIRECTIVE, quiet);
    expect(store.statements.slice(0, 3)).toEqual([
      `drop partition ${SHADOW} 202501`,
      `drop partition ${SHADOW} 202609`,
      `copy events ${SHADOW} 202609`,
    ]);
    expectRebuilt(store, ["a", "b", "c", "d", "e"]);
  });

  it("copies an older month again after the swap when the live table lacks rows of it", async () => {
    const store = new MemoryStore(
      seed().concat({ id: "f", ts: "202605", rec: "202605" }),
    );
    // The swap happened, and then the live table lost a month: the state the
    // ledger repair recreates a dropped table into.
    store.stop = { at: 5, after: true };
    await expect(rebuildPartitionKey(store, DIRECTIVE, quiet)).rejects.toThrow(
      /stopped after exchange/,
    );
    store.stop = null;
    const live = store.tables.get("events") as Table;
    live.rows = live.rows.filter((r) => r.rec !== "202605");
    await expect(rebuildPartitionKey(store, DIRECTIVE, quiet)).resolves.toBe(
      "resumed",
    );
    expectRebuilt(store, ["a", "b", "c", "d", "e", "f"]);
  });

  // #4354 review. An app node whose clock runs ahead writes into months that
  // have not begun. Sorted as text, those are the latest partitions, so a
  // rule that copied the latest two again skipped the current month, and the
  // new table's count of it (the copy plus its own writes since the swap)
  // passed the old table's, which hid the rows the old table took after the
  // month was copied.
  it("copies every month from the copy's start again, past months an app node's clock ran ahead into", async () => {
    const rows = seed().concat(
      { id: "f", ts: "202609", rec: "203001" },
      { id: "g", ts: "202609", rec: "203002" },
    );
    const store = new MemoryStore(rows);
    const expected = rows.map((r) => r.id);
    store.between = (statement) => {
      if (statement === `copy events ${SHADOW} 202609`)
        expected.push(store.write("202609").id);
      if (statement.startsWith("exchange"))
        expected.push(store.write("202609").id, store.write("202609").id);
    };
    await rebuildPartitionKey(store, DIRECTIVE, quiet);
    expectRebuilt(store, expected);
    expect(store.statements).toContain(`copy ${SHADOW} events 202609`);
  });

  it("reads the months to copy again from the old table's last write on a resume", async () => {
    const store = new MemoryStore(seed());
    // Stopped after the swap in September, resumed in November.
    store.stop = { at: 4, after: true };
    await expect(rebuildPartitionKey(store, DIRECTIVE, quiet)).rejects.toThrow(
      /stopped after exchange/,
    );
    store.stop = null;
    const late = store.write("202609", SHADOW);
    store.write("202609");
    store.write("202609");
    store.month = "202611";
    store.statements = [];
    await expect(rebuildPartitionKey(store, DIRECTIVE, quiet)).resolves.toBe(
      "resumed",
    );
    expect(store.statements).toEqual([
      `copy ${SHADOW} events 202609`,
      `drop ${SHADOW}`,
    ]);
    expect(liveIds(store)).toContain(late.id);
  });

  // #4354 review. A run that resumes after the swap may start a moment after
  // the run that swapped stopped, while an insert that began before the swap
  // is still writing to the old table. The resume has to wait for it before
  // it copies the old table's months again and drops the old table.
  it("waits, on a resume, for inserts that began before the swap", async () => {
    const store = new MemoryStore(seed());
    store.stop = { at: 4, after: true };
    await expect(rebuildPartitionKey(store, DIRECTIVE, quiet)).rejects.toThrow(
      /stopped after exchange/,
    );
    store.stop = null;
    store.running = 2;
    const landed: string[] = [];
    const sleep = vi.fn(async () => {
      // The old insert lands in the old table while the resume waits.
      if (landed.length === 0) landed.push(store.write("202609", SHADOW).id);
    });
    await expect(
      rebuildPartitionKey(store, DIRECTIVE, { log: () => {}, sleep }),
    ).resolves.toBe("resumed");
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(store.running).toBe(0);
    expectRebuilt(store, [...seed().map((r) => r.id), ...landed]);
  });

  it("waits for inserts that began before the swap", async () => {
    const store = new MemoryStore(seed());
    store.running = 2;
    const sleep = vi.fn(async () => {});
    await rebuildPartitionKey(store, DIRECTIVE, { log: () => {}, sleep });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(store.running).toBe(0);
  });

  it("stops, leaving the rest to the next run, when an old insert does not finish", async () => {
    const store = new MemoryStore(seed());
    store.running = Number.POSITIVE_INFINITY;
    let clock = 0;
    await expect(
      rebuildPartitionKey(store, DIRECTIVE, {
        log: () => {},
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        settleTimeoutMs: 2_000,
      }),
    ).rejects.toThrow(/still running after 2000 ms/);
    expect(store.tables.get("events")?.key).toBe(NEW_KEY);
    store.running = 0;
    await expect(rebuildPartitionKey(store, DIRECTIVE, quiet)).resolves.toBe(
      "resumed",
    );
    expectRebuilt(store, ["a", "b", "c", "d", "e"]);
  });

  it("waits with a real timer when none is given", async () => {
    const store = new MemoryStore(seed());
    store.running = 1;
    await expect(
      rebuildPartitionKey(store, DIRECTIVE, { log: () => {} }),
    ).resolves.toBe("rebuilt");
  });

  it("writes its progress as JSON lines by default", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const store = new MemoryStore(seed());
    await rebuildPartitionKey(store, DIRECTIVE, { sleep: async () => {} });
    const lines = write.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(lines.map((l) => l.msg)).toContain(
      "ClickHouse rebuild: swapped the tables",
    );
    expect(lines.every((l) => l.level === "info")).toBe(true);
  });

  it("refuses a table that does not exist", async () => {
    const store = new MemoryStore([]);
    store.tables.clear();
    await expect(rebuildPartitionKey(store, DIRECTIVE, quiet)).rejects.toThrow(
      /events does not exist/,
    );
  });

  it("refuses a database that cannot swap tables", async () => {
    const store = new MemoryStore(seed());
    store.engine = "Ordinary";
    await expect(rebuildPartitionKey(store, DIRECTIVE, quiet)).rejects.toThrow(
      /needs an Atomic database/,
    );
    expect(store.statements).toEqual([]);
  });

  it("refuses a shadow table it did not create", async () => {
    for (const engineFull of [
      ENGINE("toYYYYMMDD(ts)"),
      // The new key, but not the live table's settings: a shadow left before
      // a later migration changed them.
      ENGINE(NEW_KEY).replace(", min_bytes_for_wide_part = 67108864", ""),
      `${ENGINE(NEW_KEY)}, old_parts_lifetime = 1`,
    ]) {
      const store = new MemoryStore(seed());
      store.tables.set(SHADOW, {
        key: /PARTITION BY (\S+)/.exec(engineFull)?.[1] ?? "",
        engineFull,
        rows: [],
      });
      await expect(
        rebuildPartitionKey(store, DIRECTIVE, quiet),
      ).rejects.toThrow(/did not create it that way/);
      expect(store.statements).toEqual([]);
    }
  });

  it("refuses two tables that both have the new key", async () => {
    const store = new MemoryStore(seed());
    await rebuildPartitionKey(store, DIRECTIVE, quiet);
    store.tables.set(SHADOW, {
      key: NEW_KEY,
      engineFull: ENGINE(NEW_KEY),
      rows: [],
    });
    await expect(rebuildPartitionKey(store, DIRECTIVE, quiet)).rejects.toThrow(
      /does too/,
    );
  });

  it("compares keys without their spacing", async () => {
    const store = new MemoryStore(seed());
    await rebuildPartitionKey(store, DIRECTIVE, quiet);
    await expect(
      rebuildPartitionKey(
        store,
        {
          table: "events",
          partitionBy: "toYYYYMM( received_at )",
          column: "received_at",
        },
        quiet,
      ),
    ).resolves.toBe("current");
  });
});

describe("clickhouseRebuildStore", () => {
  /** A client that answers each read with `answer` and records what it sent. */
  function client(answer: unknown[]) {
    const query = vi.fn(async (_: unknown) => ({ json: async () => answer }));
    const command = vi.fn(async (_: unknown) => ({}));
    return {
      ch: { query, command } as unknown as ClickHouseClient,
      query,
      command,
    };
  }
  const sent = (mock: { mock: { calls: unknown[][] } }) =>
    mock.mock.calls.map((c) => c[0] as Record<string, unknown>);

  it("reads table shapes, the database engine, and rows per partition", async () => {
    const shapes = client([
      { name: "t", partition_key: OLD_KEY, engine_full: ENGINE(OLD_KEY) },
    ]);
    await expect(
      clickhouseRebuildStore(shapes.ch).shapes(["t", "t_rebuild"]),
    ).resolves.toEqual(
      new Map([["t", { partitionKey: OLD_KEY, engineFull: ENGINE(OLD_KEY) }]]),
    );
    expect(sent(shapes.query)[0]).toMatchObject({
      query_params: { names: ["t", "t_rebuild"] },
      clickhouse_settings: REBUILD_QUERY_SETTINGS,
    });

    const db = client([{ engine: "Atomic" }]);
    await expect(clickhouseRebuildStore(db.ch).databaseEngine()).resolves.toBe(
      "Atomic",
    );
    const none = client([]);
    await expect(
      clickhouseRebuildStore(none.ch).databaseEngine(),
    ).resolves.toBe("");

    const parts = client([{ partition: "202609", rows: "12", id: "202609" }]);
    await expect(
      clickhouseRebuildStore(parts.ch).partitionRows("t", NEW_KEY),
    ).resolves.toEqual(new Map([["202609", { rows: 12, id: "202609" }]]));
    expect(String(sent(parts.query)[0]?.["query"])).toContain(
      "toString(toYYYYMM(received_at)) AS partition",
    );
  });

  it("sends each change as one statement, the copy under its memory terms", async () => {
    const { ch, command } = client([]);
    const store = clickhouseRebuildStore(ch);
    await store.createShadow("t", "t_rebuild", ENGINE(NEW_KEY));
    await store.dropPartition("t_rebuild", "202609");
    await store.copyPartition("t", "t_rebuild", NEW_KEY, "202609");
    await store.exchange("t", "t_rebuild");
    await store.drop("t_rebuild");
    const statements = sent(command);
    expect(
      statements.map((s) => String(s["query"]).replace(/\s+/g, " ")),
    ).toEqual([
      `CREATE TABLE IF NOT EXISTS \`t_rebuild\` AS \`t\` ENGINE = ${ENGINE(NEW_KEY)}`,
      "ALTER TABLE `t_rebuild` DROP PARTITION ID {id:String}",
      "INSERT INTO `t_rebuild` SELECT * FROM `t` WHERE toString(toYYYYMM(received_at)) = {partition:String}",
      "EXCHANGE TABLES `t` AND `t_rebuild`",
      "DROP TABLE IF EXISTS `t_rebuild` SYNC",
    ]);
    expect(statements[1]?.["query_params"]).toEqual({ id: "202609" });
    expect(statements[2]).toMatchObject({
      query_params: { partition: "202609" },
      clickhouse_settings: REBUILD_QUERY_SETTINGS,
    });
    expect(String(statements[2]?.["query_id"])).toMatch(
      /^oxagen-rebuild-[0-9a-f-]{36}$/,
    );
  });

  // #4354 review. The server keeps running an INSERT ... SELECT whose client
  // gave up. Left running, a failed copy writes on into the partition the
  // next run drops and copies again.
  it("stops a failed copy on the server and reports the copy's own error", async () => {
    const { ch, command } = client([]);
    command.mockImplementation(async (params: unknown) => {
      const { query } = params as { query: string };
      if (query.startsWith("INSERT")) throw new Error("HPE_HEADER_OVERFLOW");
      if (query.startsWith("KILL")) throw new Error("not allowed");
      return {};
    });
    await expect(
      clickhouseRebuildStore(ch).copyPartition(
        "t",
        "t_rebuild",
        NEW_KEY,
        "202609",
      ),
    ).rejects.toThrow("HPE_HEADER_OVERFLOW");
    const [copy, kill] = sent(command);
    expect(kill).toEqual({
      query: "KILL QUERY WHERE query_id = {id:String} SYNC",
      query_params: { id: copy?.["query_id"] },
    });
  });

  it("reads the months a rebuild copies again", async () => {
    const now = client([{ month: "202609" }]);
    await expect(clickhouseRebuildStore(now.ch).monthBeforeNow()).resolves.toBe(
      "202609",
    );
    expect(String(sent(now.query)[0]?.["query"])).toBe(
      "SELECT toString(toYYYYMM(now() - INTERVAL 1 DAY)) AS month",
    );
    const last = client([{ month: "202608" }]);
    await expect(
      clickhouseRebuildStore(last.ch).lastWriteMonth(
        "t_rebuild",
        "received_at",
      ),
    ).resolves.toBe("202608");
    expect(String(sent(last.query)[0]?.["query"]).replace(/\s+/g, " ")).toBe(
      "SELECT toString(toYYYYMM( maxIf(`received_at`, `received_at` <= now()) - INTERVAL 1 DAY )) AS month FROM `t_rebuild`",
    );
    const none = client([]);
    await expect(
      clickhouseRebuildStore(none.ch).monthBeforeNow(),
    ).resolves.toBe("");
    await expect(
      clickhouseRebuildStore(none.ch).lastWriteMonth("t", "received_at"),
    ).resolves.toBe("");
  });

  it("counts inserts still running from before the swap", async () => {
    const running = client([{ n: "2" }]);
    await expect(
      clickhouseRebuildStore(running.ch).insertsRunningFor("t", 1.5),
    ).resolves.toBe(2);
    expect(sent(running.query)[0]?.["query_params"]).toEqual({
      table: "t",
      seconds: 1.5,
    });
    const idle = client([]);
    await expect(
      clickhouseRebuildStore(idle.ch).insertsRunningFor("t", 0),
    ).resolves.toBe(0);
  });
});
