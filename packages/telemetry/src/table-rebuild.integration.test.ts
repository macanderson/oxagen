// table-rebuild.integration.test.ts
//
// The rebuild's SQL against a real ClickHouse (#4297). CI migrates a fresh
// store, so its tacho_events is created with the new key and the directive in
// 0034 does nothing there. These tests build a table the old way instead: a
// copy of tacho_events (its columns, indexes, TTL and settings) partitioned by
// ts, filled across three producer months and two receive months. They rebuild
// it, stop a rebuild after the swap and finish it, and read back what a
// reader would. A mocked client accepts any SQL, so only a server can show the
// statements do what the state machine assumes.
//
// Skipped unless a ClickHouse at CLICKHOUSE_URL already holds tacho_events.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

process.env.CLICKHOUSE_URL ??= "http://localhost:8123";
process.env.CLICKHOUSE_USERNAME ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "";
process.env.CLICKHOUSE_DATABASE ??= "oxagen";

async function tachoEventsReady(): Promise<boolean> {
  try {
    const url = new URL("/", process.env.CLICKHOUSE_URL);
    url.searchParams.set("database", process.env.CLICKHOUSE_DATABASE ?? "");
    url.searchParams.set("query", "EXISTS TABLE tacho_events");
    const res = await fetch(url, {
      signal: AbortSignal.timeout(1_000),
      headers: {
        "X-ClickHouse-User": process.env.CLICKHOUSE_USERNAME ?? "default",
        "X-ClickHouse-Key": process.env.CLICKHOUSE_PASSWORD ?? "",
      },
    });
    return res.ok && (await res.text()).trim() === "1";
  } catch {
    return false;
  }
}

const chUp = await tachoEventsReady();

const OLD_KEY = "toYYYYMM(ts)";
const NEW_KEY = "toYYYYMM(received_at)";

afterAll(async () => {
  if (!chUp) return;
  const { closeClickhouse } = await import("./clickhouse");
  await closeClickhouse();
});

async function client() {
  const { clickhouse } = await import("./clickhouse");
  return clickhouse();
}

async function read<T>(query: string, params: Record<string, unknown> = {}) {
  const ch = await client();
  const result = await ch.query({
    query,
    query_params: params,
    format: "JSONEachRow",
  });
  return result.json<T>();
}

/** A table shaped like tacho_events and partitioned the old way, with rows. */
async function oldTable(): Promise<{ name: string; ids: string[] }> {
  const { clickhouseRebuildStore, engineWithKey } = await import(
    "./table-rebuild"
  );
  const ch = await client();
  const name = `rebuild_witness_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const live = (await clickhouseRebuildStore(ch).shapes(["tacho_events"])).get(
    "tacho_events",
  );
  if (live === undefined) throw new Error("tacho_events is missing");
  await ch.command({
    query: `CREATE TABLE ${name} AS tacho_events ENGINE = ${engineWithKey(live, OLD_KEY, "tacho_events")}`,
  });
  const org = randomUUID();
  const session = randomUUID();
  // Three producer months and a clock years ahead, received in two months.
  const clocks: [string, string][] = [
    ["2026-07-03 10:00:00.000", "2026-08-30 10:00:00.000"],
    ["2026-08-03 10:00:00.000", "2026-08-30 10:00:01.000"],
    ["2026-09-03 10:00:00.000", "2026-08-30 10:00:02.000"],
    ["2026-09-03 10:00:00.000", "2026-09-02 10:00:00.000"],
    ["2031-01-01 00:00:00.000", "2026-09-02 10:00:01.000"],
  ];
  const ids = clocks.map((_, seq) => `${session}:${seq}`);
  await ch.insert({
    table: name,
    format: "JSONEachRow",
    values: clocks.map(([ts, received], seq) => ({
      org_id: org,
      workspace_id: org,
      session_uuid: session,
      root_session_uuid: session,
      seq,
      ts,
      received_at: received,
      kind: "agent_start",
      event_id_idem: ids[seq],
    })),
  });
  return { name, ids };
}

async function shapeOf(name: string) {
  const [row] = await read<{ partition_key: string; engine_full: string }>(
    `SELECT partition_key, engine_full FROM system.tables
     WHERE database = currentDatabase() AND name = {name:String}`,
    { name },
  );
  return row;
}

async function activePartitions(name: string): Promise<string[]> {
  const rows = await read<{ partition: string }>(
    `SELECT DISTINCT partition FROM system.parts
     WHERE database = currentDatabase() AND table = {name:String} AND active
     ORDER BY partition`,
    { name },
  );
  return rows.map((r) => r.partition);
}

async function idsIn(name: string): Promise<string[]> {
  const rows = await read<{ id: string }>(
    `SELECT event_id_idem AS id FROM ${name} FINAL ORDER BY id`,
  );
  return rows.map((r) => r.id);
}

async function indexes(name: string): Promise<string[]> {
  const rows = await read<{ name: string }>(
    `SELECT name FROM system.data_skipping_indices
     WHERE database = currentDatabase() AND table = {name:String} ORDER BY name`,
    { name },
  );
  return rows.map((r) => r.name);
}

async function dropAll(name: string) {
  const ch = await client();
  await ch.command({ query: `DROP TABLE IF EXISTS ${name} SYNC` });
  await ch.command({ query: `DROP TABLE IF EXISTS ${name}_rebuild SYNC` });
}

const quiet = { log: () => {} };

describe.skipIf(!chUp)("REBUILD TABLE against ClickHouse (#4297)", () => {
  it("moves a table to the receive month, one partition per month, with its TTL, settings and indexes", async () => {
    const { clickhouseRebuildStore, rebuildPartitionKey } = await import(
      "./table-rebuild"
    );
    const { name, ids } = await oldTable();
    try {
      expect((await activePartitions(name)).length).toBe(4);
      const ch = await client();
      const store = clickhouseRebuildStore(ch);
      await expect(
        rebuildPartitionKey(
          store,
          { table: name, partitionBy: NEW_KEY },
          quiet,
        ),
      ).resolves.toBe("rebuilt");

      const shape = await shapeOf(name);
      expect(shape?.partition_key).toBe(NEW_KEY);
      const before = await shapeOf("tacho_events");
      // Everything but the key is what tacho_events carries: the 0032 TTL and
      // the 0033 settings among it.
      expect(shape?.engine_full.replace(NEW_KEY, "KEY")).toBe(
        before?.engine_full.replace(/PARTITION BY \S+/, "PARTITION BY KEY"),
      );
      expect(shape?.engine_full).toContain(
        "TTL toDateTime(received_at) + toIntervalMonth(13)",
      );
      expect(await indexes(name)).toEqual(await indexes("tacho_events"));
      expect(await activePartitions(name)).toEqual(["202608", "202609"]);
      expect(await idsIn(name)).toEqual([...ids].sort());
      expect(await shapeOf(`${name}_rebuild`)).toBeUndefined();

      // Run again: nothing to do, nothing sent.
      await expect(
        rebuildPartitionKey(
          store,
          { table: name, partitionBy: NEW_KEY },
          quiet,
        ),
      ).resolves.toBe("current");
      expect(await idsIn(name)).toEqual([...ids].sort());
    } finally {
      await dropAll(name);
    }
  }, 120_000);

  it("finishes a copy that stopped part way, dropping a partial month and a month the source no longer holds", async () => {
    const {
      clickhouseRebuildStore,
      engineWithKey,
      rebuildPartitionKey,
      shadowTableName,
    } = await import("./table-rebuild");
    const { name, ids } = await oldTable();
    const shadow = shadowTableName(name);
    try {
      const ch = await client();
      const store = clickhouseRebuildStore(ch);
      const live = (await store.shapes([name])).get(name);
      if (live === undefined) throw new Error(`${name} is missing`);
      // The state a run leaves when it stops inside the copy: the shadow holds
      // one row of September, and a month whose rows have since expired from
      // the source.
      await store.createShadow(
        name,
        shadow,
        engineWithKey(live, NEW_KEY, name),
      );
      await ch.command({
        query: `INSERT INTO ${shadow} SELECT * FROM ${name} WHERE seq = 3`,
      });
      await ch.insert({
        table: shadow,
        format: "JSONEachRow",
        values: [
          {
            org_id: randomUUID(),
            workspace_id: randomUUID(),
            session_uuid: randomUUID(),
            seq: 0,
            ts: "2025-01-02 00:00:00.000",
            received_at: "2025-01-02 00:00:00.000",
            kind: "agent_start",
            event_id_idem: "expired",
          },
        ],
      });
      expect(await activePartitions(shadow)).toEqual(["202501", "202609"]);

      await expect(
        rebuildPartitionKey(
          store,
          { table: name, partitionBy: NEW_KEY },
          quiet,
        ),
      ).resolves.toBe("rebuilt");
      expect(await idsIn(name)).toEqual([...ids].sort());
      expect(await activePartitions(name)).toEqual(["202608", "202609"]);
      expect(await shapeOf(shadow)).toBeUndefined();
    } finally {
      await dropAll(name);
    }
  }, 120_000);

  it("finishes a rebuild that stopped after the swap, with a write the old table took late", async () => {
    const { clickhouseRebuildStore, rebuildPartitionKey } = await import(
      "./table-rebuild"
    );
    const { name, ids } = await oldTable();
    try {
      const ch = await client();
      const store = clickhouseRebuildStore(ch);
      // Stop right after the swap, the way a deploy killed mid-step would,
      // after an insert that began before the swap lands in the old table.
      const late = `${randomUUID()}:late`;
      const stopping = {
        ...store,
        async exchange(a: string, b: string) {
          await store.exchange(a, b);
          await ch.insert({
            table: b,
            format: "JSONEachRow",
            values: [
              {
                org_id: randomUUID(),
                workspace_id: randomUUID(),
                session_uuid: randomUUID(),
                seq: 0,
                ts: "2026-09-02 11:00:00.000",
                received_at: "2026-09-02 11:00:00.000",
                kind: "agent_start",
                event_id_idem: late,
              },
            ],
          });
          throw new Error("stopped after the swap");
        },
      };
      await expect(
        rebuildPartitionKey(
          stopping,
          { table: name, partitionBy: NEW_KEY },
          quiet,
        ),
      ).rejects.toThrow("stopped after the swap");
      expect((await shapeOf(name))?.partition_key).toBe(NEW_KEY);
      expect((await shapeOf(`${name}_rebuild`))?.partition_key).toBe(OLD_KEY);

      await expect(
        rebuildPartitionKey(
          store,
          { table: name, partitionBy: NEW_KEY },
          quiet,
        ),
      ).resolves.toBe("resumed");
      expect(await idsIn(name)).toEqual([...ids, late].sort());
      expect(await shapeOf(`${name}_rebuild`)).toBeUndefined();
    } finally {
      await dropAll(name);
    }
  }, 120_000);
});
