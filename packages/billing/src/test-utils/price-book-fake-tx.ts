/**
 * An in-memory executor for `cost.price_entries`, for the price-book store's
 * unit tests. It runs the statements `price-book.ts` issues — the keyed read,
 * the close UPDATE, and the raw `INSERT … ON CONFLICT DO UPDATE` whose arbiter
 * restates `price_entries_key_idx`'s own expressions — from their arguments,
 * so a wrong arbiter, an unmodelled SET clause or a row the table would refuse
 * fails the test rather than passing on a guess.
 *
 * ── Before you add a test against this seam, read this ──────────────────────
 *
 * A fake that does not refuse what the real thing refuses is not a test
 * double. It is a second implementation with different rules, and every gap
 * between the two is a test that passes for the wrong reason. That warning is
 * copied from `test-utils/gau-fake-tx.ts` because it was earned there: three
 * gaps in that file had each been letting a wrong implementation pass, and
 * every one made the fake MORE permissive than Postgres.
 *
 * So this executor mirrors, and refuses on:
 *
 *   - `price_entries_org_source_check` — `(source IN ('list','override')) = (org_id IS NULL)`.
 *     A negotiated row with a null org is the single constraint that makes the
 *     write path's `org_id` argument load-bearing.
 *   - `price_entries_price_check` — `micros_per_million >= 0`.
 *   - `price_entries_effective_range_check` — `effective_to > effective_from`.
 *   - `price_entries_token_class_check` / `_unit_check` / `_source_check`.
 *   - `price_entries_key_idx` — the unique index over
 *     `(coalesce(org_id, nil), provider, model, token_class,
 *     coalesce(region, ''), effective_from)`, as the key the upsert converges
 *     on and as the arbiter the statement has to name. A statement whose ON
 *     CONFLICT target does not restate those expressions would find no index
 *     in Postgres and error at runtime, so it throws here.
 *
 * What it cannot prove: anything about concurrency. A single-threaded
 * in-memory store cannot exhibit the race the unique index and the
 * single-transaction write exist to prevent.
 */
import {
  getTableColumns,
  is,
  Param,
  SQL,
  StringChunk,
  Table,
} from "drizzle-orm";
import { schema, type Tx } from "@oxagen/database";
import type { PriceCond } from "./price-book-conditions";

export type PriceRow = Record<string, unknown>;

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const TOKEN_CLASSES = new Set([
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "output",
  "reasoning",
  "server_tool_request",
  "embedding_input",
  "rerank",
  "image",
  "video_second",
]);
const UNITS = new Set(["token", "request", "image", "second"]);
const SOURCES = new Set(["list", "negotiated", "override"]);

const columns = getTableColumns(schema.priceEntries);
/** Column object → the row's JS key (`orgId`). */
const keyByColumn = new Map<unknown, string>(
  Object.entries(columns).map(([k, c]) => [c, k]),
);
/** `micros_per_million` → `microsPerMillion`, for `EXCLUDED.<column>`. */
const keyByName = new Map<string, string>(
  Object.entries(columns).map(([k, c]) => [c.name, k]),
);

export interface FakePriceStore {
  rows: PriceRow[];
  /**
   * `cost.price_book_initializations`, keyed by `book` as the primary key is.
   * The sync reads this to learn which catalogs answered at initialization,
   * and writes one row on the run that creates the book.
   */
  initializations: PriceRow[];
  /** Every statement the executor ran, in order. */
  log: {
    op:
      | "select"
      | "update"
      | "insert"
      | "upsert"
      | "lock"
      | "delete"
      | "select_initialization"
      | "insert_initialization";
    sql?: string;
  }[];
  /** Runs when a lock is taken, standing in for the wait on another holder. */
  onLock?: () => void;
}

export function makeFakePriceStore(): FakePriceStore {
  return { rows: [], initializations: [], log: [] };
}

/** Column object → the row's JS key, for `cost.price_book_initializations`. */
const initKeyByColumn = new Map<unknown, string>(
  Object.entries(getTableColumns(schema.priceBookInitializations)).map(
    ([k, c]) => [c, k],
  ),
);

function valueOf(row: PriceRow, col: unknown): unknown {
  const key = keyByColumn.get(col) ?? initKeyByColumn.get(col);
  if (key === undefined)
    throw new Error("fake price tx: unknown column in a condition");
  return row[key];
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  return a === b;
}

function matches(row: PriceRow, cond: PriceCond): boolean {
  switch (cond.op) {
    case "and":
      return cond.conds.every((c) => matches(row, c));
    case "or":
      return cond.conds.some((c) => matches(row, c));
    case "isNull":
      return valueOf(row, cond.col) === null;
    case "gt":
      return (valueOf(row, cond.col) as Date).getTime() > cond.val.getTime();
    case "lte":
      return (valueOf(row, cond.col) as Date).getTime() <= cond.val.getTime();
    case "eq":
      return sameValue(valueOf(row, cond.col), cond.val);
    case "inArray":
      return cond.vals.some((v) => sameValue(valueOf(row, cond.col), v));
    case "arrayOverlaps": {
      const held = valueOf(row, cond.col) as unknown[];
      return cond.vals.some((v) => held.some((h) => sameValue(h, v)));
    }
  }
}

/** The unique index's key, with the two `coalesce` expressions applied. */
function indexKey(row: PriceRow): string {
  const at = row.effectiveFrom as Date;
  return [
    (row.orgId as string | null) ?? NIL_UUID,
    row.provider,
    row.model,
    row.tokenClass,
    (row.region as string | null) ?? "",
    at.toISOString(),
  ].join("|");
}

/** The table's CHECK constraints. A fake that accepts what Postgres refuses proves nothing. */
function assertChecks(row: PriceRow): void {
  const source = row.source as string;
  const orgId = row.orgId as string | null;
  if (!SOURCES.has(source))
    throw new Error(`fake price tx: violates price_entries_source_check`);
  if ((source === "list" || source === "override") !== (orgId === null))
    throw new Error(`fake price tx: violates price_entries_org_source_check`);
  if ((row.microsPerMillion as bigint) < 0n)
    throw new Error(`fake price tx: violates price_entries_price_check`);
  const from = row.effectiveFrom as Date;
  const to = row.effectiveTo as Date | null;
  if (to !== null && to.getTime() <= from.getTime())
    throw new Error(
      `fake price tx: violates price_entries_effective_range_check`,
    );
  if (!TOKEN_CLASSES.has(row.tokenClass as string))
    throw new Error(`fake price tx: violates price_entries_token_class_check`);
  if (!UNITS.has(row.unit as string))
    throw new Error(`fake price tx: violates price_entries_unit_check`);
}

/** The statement's text with a `$p` where each bound value sat, plus those values. */
function flatten(stmt: unknown): { text: string; params: unknown[] } {
  if (!is(stmt, SQL)) throw new Error("fake price tx: execute() took no SQL");
  let text = "";
  const params: unknown[] = [];
  const walk = (chunks: readonly unknown[]): void => {
    for (const chunk of chunks) {
      if (is(chunk, StringChunk)) {
        text += chunk.value.join("");
        continue;
      }
      if (is(chunk, SQL)) {
        walk(chunk.queryChunks);
        continue;
      }
      if (is(chunk, Table)) {
        text += "cost.price_entries";
        continue;
      }
      params.push(is(chunk, Param) ? chunk.value : chunk);
      text += "$p";
    }
  };
  walk(stmt.queryChunks);
  return { text: text.replace(/\s+/g, " ").trim(), params };
}

/** Split a VALUES tuple on its top-level commas (`array[a, b]` is one field). */
function splitFields(tuple: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of tuple) {
    if (ch === "[" || ch === "(") depth += 1;
    if (ch === "]" || ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out;
}

/**
 * The INSERT's column list and values, read off the statement rather than
 * assumed, so a reordered or renamed column is a failure here rather than a
 * silent mismatch.
 */
function readInsert(text: string, params: unknown[]): PriceRow {
  const columnsMatch =
    /INSERT INTO cost\.price_entries \(([^)]*)\) VALUES/i.exec(text);
  const valuesMatch = /VALUES \(([\s\S]*?)\) ON CONFLICT/i.exec(text);
  if (!columnsMatch || !valuesMatch)
    throw new Error(`fake price tx: unmodelled statement: ${text}`);
  const names = columnsMatch[1]!.split(",").map((s) => s.trim());
  const fields = splitFields(valuesMatch[1]!);
  if (names.length !== fields.length)
    throw new Error(
      `fake price tx: ${names.length} columns but ${fields.length} values`,
    );

  const row: PriceRow = {};
  let next = 0;
  const take = (): unknown => {
    if (next >= params.length)
      throw new Error(
        "fake price tx: statement bound fewer values than it uses",
      );
    return params[next++];
  };
  for (const [i, field] of fields.entries()) {
    const name = names[i]!;
    const key = keyByName.get(name);
    if (key === undefined)
      throw new Error(`fake price tx: unknown column ${name}`);
    if (/^array\[/i.test(field)) {
      const count = (field.match(/\$p/g) ?? []).length;
      row[key] = Array.from({ length: count }, () => take() as string);
      continue;
    }
    if (/^NULL$/i.test(field)) {
      row[key] = null;
      continue;
    }
    const literal = /^'([^']*)'$/.exec(field);
    if (literal) {
      row[key] = literal[1];
      continue;
    }
    if (!field.startsWith("$p"))
      throw new Error(`fake price tx: unmodelled VALUES field: ${field}`);
    const bound = take();
    // The casts the writer spells out: a bigint and an instant travel as
    // strings, a uuid as a string. Anything else is passed through as bound.
    if (/::bigint/.test(field)) row[key] = BigInt(bound as string);
    else if (/::timestamptz/.test(field)) row[key] = new Date(bound as string);
    else row[key] = bound;
  }
  if (next !== params.length)
    throw new Error("fake price tx: statement bound values it never used");
  return row;
}

/**
 * Whether the ON CONFLICT target restates the unique index's expressions. A
 * target that names bare `org_id`/`region` matches no index in Postgres and
 * the statement errors at runtime, so it must fail here too.
 */
function assertArbiter(text: string): void {
  const target = /ON CONFLICT \(([\s\S]*?)\) DO UPDATE/i.exec(text)?.[1];
  if (!target)
    throw new Error("fake price tx: insert names no ON CONFLICT target");
  const normalized = target.replace(/\s+/g, " ").toLowerCase();
  const required = [
    "coalesce(org_id",
    "provider",
    "model",
    "token_class",
    "coalesce(region, '')",
    "effective_from",
  ];
  for (const part of required) {
    if (!normalized.includes(part))
      throw new Error(
        `fake price tx: ON CONFLICT target does not restate price_entries_key_idx (${part} missing)`,
      );
  }
}

/** Apply the DO UPDATE SET clause. Anything it does not model throws. */
function applyConflictSet(
  text: string,
  existing: PriceRow,
  inserted: PriceRow,
) {
  const set = /DO UPDATE SET ([\s\S]*)$/i.exec(text)?.[1];
  if (!set) throw new Error("fake price tx: ON CONFLICT with no SET clause");
  for (const assignment of set.split(",")) {
    const [rawCol, rawVal] = assignment.split("=").map((s) => s.trim());
    if (!rawCol || !rawVal)
      throw new Error(`fake price tx: unmodelled SET: ${assignment}`);
    const key = keyByName.get(rawCol);
    if (key === undefined)
      throw new Error(`fake price tx: unknown SET column ${rawCol}`);
    const excluded = /^EXCLUDED\.(\w+)$/i.exec(rawVal);
    if (excluded) {
      const sourceKey = keyByName.get(excluded[1]!.toLowerCase());
      if (sourceKey === undefined)
        throw new Error(
          `fake price tx: unknown EXCLUDED column ${excluded[1]}`,
        );
      existing[key] = inserted[sourceKey];
      continue;
    }
    if (/^NULL$/i.test(rawVal)) {
      existing[key] = null;
      continue;
    }
    if (/^now\(\)$/i.test(rawVal)) {
      existing[key] = new Date();
      continue;
    }
    // `col = cost.price_entries.col` — the row's own current value, which is
    // how the writer says "leave this alone on conflict". Postgres reads the
    // pre-update row here, so the existing value stands.
    const selfRef = /^cost\.price_entries\.(\w+)$/i.exec(rawVal);
    if (selfRef) {
      const sourceKey = keyByName.get(selfRef[1]!.toLowerCase());
      if (sourceKey === undefined)
        throw new Error(`fake price tx: unknown column ${selfRef[1]}`);
      existing[key] = existing[sourceKey];
      continue;
    }
    throw new Error(`fake price tx: unmodelled SET expression: ${assignment}`);
  }
}

/** A write drizzle lets the caller await directly. */
function thenable<T>(run: () => T) {
  return {
    returning: () => Promise.resolve(run()),
    then: <R>(onFulfilled: (v: T) => R) =>
      Promise.resolve(run()).then(onFulfilled),
  };
}

/**
 * The executor, typed as the `Tx` the store takes. A test seeds rows by
 * pushing onto `store.rows` (use {@link priceRow}); `store.log` is the
 * statement log.
 */
/**
 * The clock the fake stamps `created_at` with on insert. A test that pins the
 * write's `now` sets this to the same instant, the way Postgres's `now()`
 * would agree with the transaction; null means the wall clock.
 */
export const fakeClock: { now: Date | null } = { now: null };

export function makeFakePriceTx(store: FakePriceStore): Tx {
  return fakePriceExecutor(store) as unknown as Tx;
}

export function fakePriceExecutor(store: FakePriceStore) {
  const assertTable = (table: unknown) => {
    if (table !== schema.priceEntries)
      throw new Error("fake price tx: unexpected table");
  };
  return {
    select: () => ({
      from: (table: unknown) => {
        // The initialization record: one row per book, read by primary key.
        // Modelled as its own read because it is its own table, and a fake
        // that answered it out of `price_entries` would prove nothing about
        // the fact this record exists to hold.
        if (table === schema.priceBookInitializations) {
          let initRows = store.initializations.slice();
          const initChain = {
            where: (cond: PriceCond) => {
              initRows = initRows.filter((r) => matches(r, cond));
              return initChain;
            },
            then: <R>(onFulfilled: (v: PriceRow[]) => R) => {
              store.log.push({ op: "select_initialization" });
              return Promise.resolve(initRows.map((r) => ({ ...r }))).then(
                onFulfilled,
              );
            },
          };
          return initChain;
        }
        assertTable(table);
        let rows = store.rows.slice();
        const chain = {
          where: (cond: PriceCond) => {
            rows = rows.filter((r) => matches(r, cond));
            return chain;
          },
          orderBy: (...order: unknown[]) => {
            rows.sort((a, b) => {
              for (const col of order) {
                if (is(col, SQL)) {
                  const result =
                    (b.effectiveFrom as Date).getTime() -
                    (a.effectiveFrom as Date).getTime();
                  if (result !== 0) return result;
                } else {
                  const result = String(valueOf(a, col)).localeCompare(
                    String(valueOf(b, col)),
                  );
                  if (result !== 0) return result;
                }
              }
              return 0;
            });
            return chain;
          },
          // A select is thenable at every stage in drizzle — an unlimited read
          // runs the query.
          then: <R>(onFulfilled: (v: PriceRow[]) => R) => {
            store.log.push({ op: "select" });
            return Promise.resolve(rows.map((r) => ({ ...r }))).then(
              onFulfilled,
            );
          },
        };
        return chain;
      },
    }),

    // The one INSERT issued through the builder rather than raw SQL: the
    // initialization record, `ON CONFLICT DO NOTHING` on its primary key so a
    // second first-sync cannot overwrite the first's view of which catalogs
    // answered.
    insert: (table: unknown) => ({
      values: (row: PriceRow) => ({
        onConflictDoNothing: () =>
          thenable(() => {
            if (table !== schema.priceBookInitializations)
              throw new Error(
                "fake price tx: unexpected insert() target; only the initialization record is written this way",
              );
            store.log.push({ op: "insert_initialization" });
            if (row.book !== "list")
              throw new Error(
                "fake price tx: violates price_book_initializations_book_check",
              );
            if (!(row.initializedAt instanceof Date))
              throw new Error(
                "fake price tx: price_book_initializations.initialized_at is NOT NULL",
              );
            if (store.initializations.some((r) => r.book === row.book))
              return [];
            store.initializations.push({
              createdAt: fakeClock.now ?? new Date(),
              updatedAt: fakeClock.now ?? new Date(),
              createdById: null,
              updatedById: null,
              completedCatalogs: [],
              ...row,
            });
            return [];
          }),
      }),
    }),

    update: (table: unknown) => ({
      set: (patch: PriceRow) => ({
        where: (cond: PriceCond) =>
          thenable(() => {
            assertTable(table);
            store.log.push({ op: "update" });
            const hit = store.rows.filter((r) => matches(r, cond));
            for (const row of hit) {
              const next = { ...row, ...patch };
              assertChecks(next);
              Object.assign(row, patch);
            }
            return hit.map((r) => ({ ...r }));
          }),
      }),
    }),

    // The one DELETE the store issues: a scheduled negotiated row that has not
    // begun, cancelled by an end of the rate at an earlier instant. Nothing
    // else may delete a price row, so the fake models exactly that and no more.
    delete: (table: unknown) => ({
      where: (cond: PriceCond) =>
        thenable(() => {
          assertTable(table);
          store.log.push({ op: "delete" });
          const hit = store.rows.filter((r) => matches(r, cond));
          store.rows = store.rows.filter((r) => !matches(r, cond));
          return hit.map((r) => ({ ...r }));
        }),
    }),

    execute: (stmt: unknown) => {
      const { text, params } = flatten(stmt);
      // The per-key advisory lock the negotiated write takes so two
      // corrections to one key cannot interleave. Nothing to simulate: this
      // executor is single-threaded, and the statement is logged so a test can
      // assert the write asks for the lock before it reads.
      if (/pg_advisory_xact_lock/i.test(text)) {
        // The key travels as a bound value; rendered into the log so a test can
        // assert WHICH lock was taken, not only that one was.
        store.log.push({ op: "lock", sql: `${text} ${String(params[0])}` });
        // A test can make the lock "wait": whatever it runs here happens
        // between taking the lock and the first read, as another holder's
        // transaction would.
        store.onLock?.();
        return Promise.resolve([]);
      }
      if (!/^INSERT INTO cost\.price_entries/i.test(text))
        throw new Error(`fake price tx: unmodelled execute(): ${text}`);
      assertArbiter(text);
      const inserted = readInsert(text, params);
      const existing = store.rows.find(
        (r) => indexKey(r) === indexKey(inserted),
      );
      if (existing) {
        const probe = { ...existing };
        applyConflictSet(text, probe, inserted);
        assertChecks(probe);
        Object.assign(existing, probe);
        store.log.push({ op: "upsert", sql: text });
        return Promise.resolve([]);
      }
      const row: PriceRow = {
        id: crypto.randomUUID(),
        createdAt: fakeClock.now ?? new Date(),
        updatedAt: new Date(),
        createdByUserId: null,
        updatedByUserId: null,
        modelAliases: [],
        region: null,
        currency: "USD",
        effectiveTo: null,
        ...inserted,
      };
      assertChecks(row);
      store.rows.push(row);
      store.log.push({ op: "insert", sql: text });
      return Promise.resolve([]);
    },
  };
}

/** A seeded row, in the shape the table stores. */
export function priceRow(over: Partial<PriceRow> = {}): PriceRow {
  const row: PriceRow = {
    id: crypto.randomUUID(),
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    createdByUserId: null,
    updatedByUserId: null,
    orgId: null,
    provider: "anthropic",
    model: "claude-sonnet-5",
    modelAliases: [],
    region: null,
    tokenClass: "input_uncached",
    unit: "token",
    currency: "USD",
    microsPerMillion: 3_000_000n,
    effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
    effectiveTo: null,
    source: "list",
    ...over,
  };
  assertChecks(row);
  return row;
}

/**
 * A seeded `cost.price_book_initializations` row. `completedCatalogs` is the
 * set the first sync vouched for; a book seeded without one of these is a book
 * initialized before the record existed.
 */
export function initializationRow(over: Partial<PriceRow> = {}): PriceRow {
  return {
    book: "list",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    createdById: null,
    updatedById: null,
    initializedAt: new Date("2026-09-01T00:00:00.000Z"),
    completedCatalogs: [],
    ...over,
  };
}
