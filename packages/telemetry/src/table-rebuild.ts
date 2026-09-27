/**
 * A migration step that moves a table to a new partition key (#4297).
 *
 * ClickHouse cannot change a table's partition key in place. The table has to
 * be rebuilt: a new table with the new key, a copy, a swap, and a drop. A
 * numbered migration file cannot hold that as plain SQL. `EXCHANGE TABLES`
 * swaps back when it runs twice, so the file would not survive the ledger
 * repair (#3698) or a retry after a failure part way through. And one
 * `INSERT ... SELECT` over the whole table is the kind of write that reaches
 * the app node's 1.5 GiB cap (ADR-181).
 *
 * So a migration file names the rebuild with one directive, and the runner
 * hands it here:
 *
 *   REBUILD TABLE tacho_events PARTITION BY toYYYYMM(received_at);
 *
 * The directive is not ClickHouse SQL. Applied by hand it fails with a syntax
 * error, which is the point: only this code knows how to run it safely.
 *
 * Every run reads where the rebuild stands from `system.tables` and carries on
 * from there, so a run that stops at any step is finished by the next one, and
 * a run after the rebuild is done changes nothing:
 *
 * 1. The live table already has the new key and no shadow table exists. Done,
 *    or a cluster that was created with the new key. Nothing to do.
 * 2. The live table has the old key. Create the shadow table with the new key
 *    (`CREATE TABLE ... AS`, so it has the same columns, indexes, TTL, and
 *    settings), and copy the rows one target partition at a time. A partition
 *    the shadow already holds in full is skipped. One it holds in part is
 *    dropped and copied again. Then swap the two tables.
 * 3. The live table has the new key and the shadow holds the old rows: the
 *    swap happened. Wait for inserts that began before this run, copy again
 *    whatever the swap could have left behind, then drop the shadow.
 *
 * Writes keep arriving during the copy. The key is a month of a time the
 * control plane stamps (`received_at`), so a write lands in the partition for
 * the moment it arrives. Only the months from the copy's start onward can
 * receive rows after they were copied, and the months ahead of it too, which
 * an app node whose clock runs ahead writes into. After the swap every one of
 * those months is copied again from the old table, along with any older month
 * the new table holds fewer rows of. The table is a `ReplacingMergeTree`, and
 * every reader uses `FINAL`, so a row copied twice reads once.
 */
import { randomUUID } from "node:crypto";
import type {
  ClickHouseClient,
  ClickHouseClientConfigOptions,
  ClickHouseSettings,
} from "@clickhouse/client";

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const DIRECTIVE = new RegExp(
  `^REBUILD\\s+TABLE\\s+(${NAME})\\s+PARTITION\\s+BY\\s+toYYYYMM\\((${NAME})\\)$`,
  "i",
);

/** One `REBUILD TABLE <table> PARTITION BY toYYYYMM(<column>)` directive. */
export interface RebuildDirective {
  table: string;
  /** The new partition key, as the directive spells it. */
  partitionBy: string;
  /** The column the new key reads. */
  column: string;
}

/** Raised for a statement that starts like a rebuild directive and is not one. */
export class RebuildDirectiveError extends Error {
  readonly code = "CLICKHOUSE_REBUILD_DIRECTIVE";
  constructor(message: string) {
    super(message);
    this.name = "RebuildDirectiveError";
  }
}

/**
 * The rebuild `statement` names, or null for any other statement.
 *
 * Only a monthly key on one column is accepted. The copy's handling of writes
 * that arrive during it depends on that shape (see the header), so any other
 * key is refused rather than rebuilt on a rule that does not hold for it.
 */
export function parseRebuildDirective(
  statement: string,
): RebuildDirective | null {
  const text = statement.trim().replace(/\s+/g, " ");
  if (!/^REBUILD\b/i.test(text)) return null;
  const match = DIRECTIVE.exec(text);
  if (match === null) {
    throw new RebuildDirectiveError(
      `not a rebuild directive this runner can apply: "${text}". The form is REBUILD TABLE <table> PARTITION BY toYYYYMM(<column>).`,
    );
  }
  const [, table = "", column = ""] = match;
  return { table, partitionBy: `toYYYYMM(${column})`, column };
}

/** The shadow table a rebuild of `table` copies into. */
export function shadowTableName(table: string): string {
  return `${table}_rebuild`;
}

/** A partition key as `system.tables` spells it, compared without spacing. */
function sameKey(a: string, b: string): boolean {
  return a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

/**
 * The memory terms of every query that reads or copies rows here.
 *
 * Measured on ClickHouse 24.8 against a 600,000-row copy of `tacho_events`:
 * with the defaults the copy wrote wide parts and passed 1.3 GiB before it
 * failed. One thread and insert blocks of about 4 MiB keep most blocks small,
 * but a block is never smaller than one granule of the part it was read from,
 * and a compact part's granule can pass 10 MiB. What keeps every part the
 * copy writes compact is the table's own `min_bytes_for_wide_part` (0033),
 * which the shadow table inherits.
 *
 * `max_memory_usage` is a third of the node's cap, so a copy that grows past
 * the measurement stops with code 241 before it can take the node down, and
 * the next run resumes it. The overcommit denominators are left at their
 * defaults. Ingest takes itself out of the server's choice of what to stop
 * (`TACHO_EVENTS_INSERT_SETTINGS`), and under pressure the copy is the query
 * that should give way.
 */
export const REBUILD_QUERY_SETTINGS: ClickHouseSettings = {
  max_memory_usage: String(512 * 1024 * 1024),
  max_threads: 1,
  max_insert_threads: "1",
  max_block_size: "1024",
  min_insert_block_size_rows: "0",
  min_insert_block_size_bytes: String(4 * 1024 * 1024),
};

/**
 * The client options a rebuild runs under (`migrate.ts` adds the connection).
 *
 * The shared client gives up on a request after 30 seconds, and a copy of a
 * large partition can take longer. This waits up to 30 minutes per statement,
 * the time `migration-gate` allows the whole job, and asks the server for a
 * progress header every 10 seconds so the SSM tunnel carries bytes while a
 * copy runs.
 *
 * An `INSERT ... SELECT` sends no body, so each progress line is one more
 * response header. Node accepts 16 KiB of headers by default, about 75 of
 * those lines, and a copy longer than 12 minutes would fail with
 * `HPE_HEADER_OVERFLOW` while the server carried on writing. The 1 MiB bound
 * holds 30 minutes of them many times over.
 */
export const REBUILD_CLIENT_OPTIONS = {
  request_timeout: 30 * 60_000,
  max_response_headers_size: 1024 * 1024,
  clickhouse_settings: {
    send_progress_in_http_headers: 1,
    http_headers_progress_interval_ms: "10000",
  },
} satisfies ClickHouseClientConfigOptions;

/** A table as `system.tables` describes it. */
export interface TableShape {
  partitionKey: string;
  engineFull: string;
}

/** Rows per partition, and the partition's id where the table has one. */
export type PartitionRows = Map<string, { rows: number; id: string }>;

/**
 * The operations a rebuild needs, one per statement it sends. Split from the
 * decisions so the state machine can be driven through every failure point in
 * a unit test, and the SQL proved once against a real server.
 */
export interface RebuildStore {
  /** The named tables in the current database that exist. */
  shapes(names: readonly string[]): Promise<Map<string, TableShape>>;
  /** The current database's engine: `Atomic` supports `EXCHANGE TABLES`. */
  databaseEngine(): Promise<string>;
  /** Rows of `table` per value of `partitionBy`, keyed by the value as text. */
  partitionRows(table: string, partitionBy: string): Promise<PartitionRows>;
  /** Create `shadow` with the columns of `table` and the engine `engine`. */
  createShadow(table: string, shadow: string, engine: string): Promise<void>;
  /** Drop one partition of `table` by its id. */
  dropPartition(table: string, id: string): Promise<void>;
  /**
   * The month, as `toYYYYMM` text, of the server's clock one day ago: the
   * earliest month a write from now on can land in, allowing an app node's
   * clock a day behind.
   */
  monthBeforeNow(): Promise<string>;
  /**
   * The month, as `toYYYYMM` text, one day before the latest value of
   * `column` in `table` that is not ahead of the server's clock. The old
   * table stops taking writes at the swap, so this is a month no later than
   * the copy's start. A table with no such row answers a month before any.
   */
  lastWriteMonth(table: string, column: string): Promise<string>;
  /**
   * Append the rows of `from` whose `partitionBy` value is `partition` to
   * `to`. A copy that fails is stopped on the server before this rejects.
   */
  copyPartition(
    from: string,
    to: string,
    partitionBy: string,
    partition: string,
  ): Promise<void>;
  exchange(a: string, b: string): Promise<void>;
  drop(table: string): Promise<void>;
  /** Running inserts whose text names `table` and that began at least `seconds` ago. */
  insertsRunningFor(table: string, seconds: number): Promise<number>;
}

export interface RebuildOptions {
  /** Progress lines, one JSON object each. */
  log?: (entry: Record<string, unknown>) => void;
  /** How long to wait for inserts that began before the swap. */
  settleTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type RebuildOutcome = "current" | "rebuilt" | "resumed";

/** Raised when the tables are in a state no step of the rebuild produces. */
export class RebuildStateError extends Error {
  readonly code = "CLICKHOUSE_REBUILD_STATE";
  constructor(message: string) {
    super(message);
    this.name = "RebuildStateError";
  }
}

const defaultLog = (entry: Record<string, unknown>) =>
  process.stdout.write(JSON.stringify({ level: "info", ...entry }) + "\n");

/** The engine clause of `live` with its partition key replaced. */
export function engineWithKey(
  live: TableShape,
  partitionBy: string,
  table: string,
): string {
  const clause = `PARTITION BY ${live.partitionKey}`;
  const at = live.engineFull.indexOf(clause);
  if (
    live.partitionKey === "" ||
    at < 0 ||
    live.engineFull.indexOf(clause, at + 1) >= 0
  ) {
    throw new RebuildStateError(
      `cannot find one "${clause}" in the engine of ${table}: ${live.engineFull}`,
    );
  }
  return (
    live.engineFull.slice(0, at) +
    `PARTITION BY ${partitionBy}` +
    live.engineFull.slice(at + clause.length)
  );
}

/**
 * Copy every partition of `from` that `to` does not hold in full, dropping a
 * partial copy first. Used before the swap, when `to` takes no other writes,
 * so equal counts mean the partition is there.
 */
async function copyMissing(
  store: RebuildStore,
  from: string,
  to: string,
  partitionBy: string,
  log: (entry: Record<string, unknown>) => void,
): Promise<number> {
  const source = await store.partitionRows(from, partitionBy);
  const target = await store.partitionRows(to, partitionBy);
  // A partition the source no longer has (its rows expired under the TTL
  // since an earlier run copied them) must not come back through the copy.
  for (const [partition, { id }] of target) {
    if (!source.has(partition)) await store.dropPartition(to, id);
  }
  let copied = 0;
  for (const [partition, { rows }] of [...source].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const held = target.get(partition);
    if (held?.rows === rows) continue;
    if (held !== undefined) await store.dropPartition(to, held.id);
    await store.copyPartition(from, to, partitionBy, partition);
    copied += rows;
    log({
      msg: "ClickHouse rebuild: copied a partition",
      from,
      to,
      partition,
      rows,
    });
  }
  return copied;
}

/**
 * After the swap: copy from the old table what the new one may lack. Every
 * partition from `from` on is copied again whatever its count: writes reached
 * those months during the copy, and the new table has taken writes of its own
 * since, so a count cannot show what it lacks. That includes months ahead of
 * the server's, which an app node whose clock runs ahead writes into. Any
 * older partition is copied again only when the new table holds fewer of its
 * rows than the old one.
 */
async function copyTail(
  store: RebuildStore,
  old: string,
  live: string,
  partitionBy: string,
  from: string,
  log: (entry: Record<string, unknown>) => void,
): Promise<void> {
  const before = await store.partitionRows(old, partitionBy);
  const now = await store.partitionRows(live, partitionBy);
  const ordered = [...before.keys()].sort((a, b) => a.localeCompare(b));
  for (const partition of ordered) {
    const rows = before.get(partition)?.rows ?? 0;
    const held = now.get(partition)?.rows ?? 0;
    if (partition.localeCompare(from) < 0 && held >= rows) continue;
    await store.copyPartition(old, live, partitionBy, partition);
    log({
      msg: "ClickHouse rebuild: copied a partition again after the swap",
      from: old,
      to: live,
      partition,
      rows,
    });
  }
}

/**
 * Wait until no insert that began before the swap is still writing to the old
 * table. An insert keeps the table it started on, so one still running after
 * the swap lands its rows in the old table, and the copy after the swap has to
 * start after it ends. Those inserts named the table by its live name, so
 * that is the name to look for, among inserts older than the swap.
 */
async function settle(
  store: RebuildStore,
  table: string,
  swappedAt: number,
  options: Required<Pick<RebuildOptions, "settleTimeoutMs" | "sleep" | "now">>,
): Promise<void> {
  const deadline = swappedAt + options.settleTimeoutMs;
  for (;;) {
    const age = Math.max(0, (options.now() - swappedAt) / 1000 - 1);
    if ((await store.insertsRunningFor(table, age)) === 0) return;
    if (options.now() >= deadline) {
      throw new RebuildStateError(
        `inserts into ${table} that began before the swap are still running after ${options.settleTimeoutMs} ms. The next run copies what they wrote and finishes the rebuild.`,
      );
    }
    await options.sleep(500);
  }
}

/** Run `directive` to completion from whatever state the tables are in. */
export async function rebuildPartitionKey(
  store: RebuildStore,
  directive: RebuildDirective,
  options: RebuildOptions = {},
): Promise<RebuildOutcome> {
  const log = options.log ?? defaultLog;
  const timing = {
    settleTimeoutMs: options.settleTimeoutMs ?? 60_000,
    sleep:
      options.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    now: options.now ?? (() => Date.now()),
  };
  const { table, partitionBy, column } = directive;
  const shadow = shadowTableName(table);
  const shapes = await store.shapes([table, shadow]);
  const live = shapes.get(table);
  const spare = shapes.get(shadow);
  if (live === undefined) {
    throw new RebuildStateError(
      `${table} does not exist. The migration that creates it has to run before it can be rebuilt.`,
    );
  }

  if (sameKey(live.partitionKey, partitionBy)) {
    if (spare === undefined) return "current";
    if (sameKey(spare.partitionKey, partitionBy)) {
      throw new RebuildStateError(
        `${table} already partitions by ${partitionBy}, and ${shadow} does too. No step of the rebuild leaves both, so it stops rather than drop either. Read both tables and drop the one that is not the live data.`,
      );
    }
    // The swap happened and the run stopped before it finished, perhaps a
    // moment ago. An insert that began before the swap may still be writing
    // to the old table, and it named the live table, as every insert since
    // has, so waiting for every insert older than this run covers it. This
    // run did not see the copy start, so the months to copy again are read
    // from the old table's last write.
    log({ msg: "ClickHouse rebuild: resuming after the swap", table, shadow });
    await settle(store, table, timing.now(), timing);
    const from = await store.lastWriteMonth(shadow, column);
    await copyTail(store, shadow, table, partitionBy, from, log);
    await store.drop(shadow);
    return "resumed";
  }

  const engine = await store.databaseEngine();
  if (engine !== "Atomic") {
    throw new RebuildStateError(
      `${table} is in a database with the ${engine} engine. The rebuild swaps tables with EXCHANGE TABLES, which needs an Atomic database.`,
    );
  }
  // The shadow becomes the live table at the swap, so it has to be exactly
  // what this run would create: the live engine, TTL and settings, with the
  // new key. One left by anything else, or by a run before a later migration
  // changed the live table's settings, is refused rather than swapped in.
  const wanted = engineWithKey(live, partitionBy, table);
  if (spare !== undefined && spare.engineFull !== wanted) {
    throw new RebuildStateError(
      `${shadow} exists with the engine "${spare.engineFull}", not "${wanted}". The rebuild did not create it that way, so it stops rather than copy into it or drop it. Drop ${shadow} if it holds nothing you need, and run again.`,
    );
  }
  // Read before the first copy: the months from here on are the ones writes
  // can reach after they were copied.
  const from = await store.monthBeforeNow();
  if (spare === undefined) await store.createShadow(table, shadow, wanted);
  const copied = await copyMissing(store, table, shadow, partitionBy, log);
  await store.exchange(table, shadow);
  const swappedAt = timing.now();
  log({
    msg: "ClickHouse rebuild: swapped the tables",
    table,
    partitionBy,
    copied,
  });
  await settle(store, table, swappedAt, timing);
  await copyTail(store, shadow, table, partitionBy, from, log);
  await store.drop(shadow);
  return "rebuilt";
}

// ── The SQL ────────────────────────────────────────────────────────────────

const quoted = (name: string) => `\`${name.replace(/`/g, "")}\``;

async function rows<T>(
  ch: ClickHouseClient,
  query: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const result = await ch.query({
    query,
    query_params: params,
    format: "JSONEachRow",
    clickhouse_settings: REBUILD_QUERY_SETTINGS,
  });
  return result.json<T>();
}

/** The store over a live ClickHouse connection. */
export function clickhouseRebuildStore(ch: ClickHouseClient): RebuildStore {
  return {
    async shapes(names) {
      const found = await rows<{
        name: string;
        partition_key: string;
        engine_full: string;
      }>(
        ch,
        `SELECT name, partition_key, engine_full FROM system.tables
         WHERE database = currentDatabase() AND name IN {names:Array(String)}`,
        { names: [...names] },
      );
      return new Map(
        found.map((t) => [
          t.name,
          { partitionKey: t.partition_key, engineFull: t.engine_full },
        ]),
      );
    },
    async databaseEngine() {
      const [db] = await rows<{ engine: string }>(
        ch,
        "SELECT engine FROM system.databases WHERE name = currentDatabase()",
      );
      return db?.engine ?? "";
    },
    async partitionRows(table, partitionBy) {
      const found = await rows<{ partition: string; rows: string; id: string }>(
        ch,
        `SELECT toString(${partitionBy}) AS partition, count() AS rows,
                any(_partition_id) AS id
         FROM ${quoted(table)} GROUP BY partition`,
      );
      return new Map(
        found.map((r) => [r.partition, { rows: Number(r.rows), id: r.id }]),
      );
    },
    async createShadow(table, shadow, engine) {
      await ch.command({
        query: `CREATE TABLE IF NOT EXISTS ${quoted(shadow)} AS ${quoted(table)} ENGINE = ${engine}`,
      });
    },
    async dropPartition(table, id) {
      await ch.command({
        query: `ALTER TABLE ${quoted(table)} DROP PARTITION ID {id:String}`,
        query_params: { id },
      });
    },
    async monthBeforeNow() {
      const [row] = await rows<{ month: string }>(
        ch,
        "SELECT toString(toYYYYMM(now() - INTERVAL 1 DAY)) AS month",
      );
      return row?.month ?? "";
    },
    async lastWriteMonth(table, column) {
      const [row] = await rows<{ month: string }>(
        ch,
        `SELECT toString(toYYYYMM(
                  maxIf(${quoted(column)}, ${quoted(column)} <= now()) - INTERVAL 1 DAY
                )) AS month
         FROM ${quoted(table)}`,
      );
      return row?.month ?? "";
    },
    async copyPartition(from, to, partitionBy, partition) {
      const queryId = `oxagen-rebuild-${randomUUID()}`;
      try {
        await ch.command({
          query: `INSERT INTO ${quoted(to)} SELECT * FROM ${quoted(from)}
                  WHERE toString(${partitionBy}) = {partition:String}`,
          query_params: { partition },
          query_id: queryId,
          clickhouse_settings: REBUILD_QUERY_SETTINGS,
        });
      } catch (err) {
        // The server keeps running a write the client stopped waiting for.
        // Left running, it would go on writing into the partition the next
        // run drops and copies again, and hold memory on the shared node.
        // The copy's own error is the one to report, so a failed stop is
        // not raised over it.
        await ch
          .command({
            query: "KILL QUERY WHERE query_id = {id:String} SYNC",
            query_params: { id: queryId },
          })
          .catch(() => {});
        throw err;
      }
    },
    async exchange(a, b) {
      await ch.command({
        query: `EXCHANGE TABLES ${quoted(a)} AND ${quoted(b)}`,
      });
    },
    async drop(table) {
      await ch.command({ query: `DROP TABLE IF EXISTS ${quoted(table)} SYNC` });
    },
    async insertsRunningFor(table, seconds) {
      const [running] = await rows<{ n: string }>(
        ch,
        `SELECT count() AS n FROM system.processes
         WHERE query_kind = 'Insert'
           AND positionCaseInsensitive(query, {table:String}) > 0
           AND elapsed >= {seconds:Float64}`,
        { table, seconds },
      );
      return Number(running?.n ?? 0);
    },
  };
}
