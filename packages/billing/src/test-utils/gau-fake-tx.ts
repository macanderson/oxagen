/**
 * An in-memory executor for the GAU bucket and settlement writers, for unit
 * tests. It runs the statements gau-bucket.ts and gau-settlements.ts issue
 * — the upsert, the re-checked claim UPDATE, the settlement INSERT — from
 * their arguments: the upsert's arbiter must be `(org_id, period_start)` and
 * its SET clause is interpreted, so an overwrite where the writer means an
 * add, or a wrong arbiter, fails the tests that ride on the statement. Every
 * statement is recorded, so a test can assert what was written and that the
 * executor it passed in is the one the function used.
 *
 * Conditions are the plain objects the test's `drizzle-orm` mock builds
 * (`test-utils/gau-conditions.ts`); a column is matched by identity against
 * the real schema, and the one SQL expression a WHERE carries —
 * `gauRemainingSql()` — is evaluated by its documented meaning.
 */

import { getTableColumns, is, StringChunk, type SQL } from "drizzle-orm";
import { schema, type Tx } from "@oxagen/database";
import { gauRemainingSql, remainingGau } from "../gau-bucket";
import type { Cond } from "./gau-conditions";

type Row = Record<string, unknown>;

export interface StatementLog {
  op: "select" | "insert" | "upsert" | "update";
  table: string;
  values?: Row;
  set?: Row;
}

export interface FakeGauStore {
  buckets: Row[];
  settlements: Row[];
  log: StatementLog[];
}

export function makeFakeGauStore(): FakeGauStore {
  return { buckets: [], settlements: [], log: [] };
}

const bucketKeys = new Map<unknown, string>(
  Object.entries(getTableColumns(schema.gauBuckets)).map(([k, c]) => [c, k]),
);
const settlementKeys = new Map<unknown, string>(
  Object.entries(getTableColumns(schema.gauSettlements)).map(([k, c]) => [
    c,
    k,
  ]),
);
/** `used_gau` → `usedGau`, for the `excluded.<column>` reference a SET carries. */
const bucketKeyByName = new Map<string, string>(
  Object.entries(getTableColumns(schema.gauBuckets)).map(([k, c]) => [
    c.name,
    k,
  ]),
);

function tableName(table: unknown): "buckets" | "settlements" {
  if (table === schema.gauBuckets) return "buckets";
  if (table === schema.gauSettlements) return "settlements";
  throw new Error("fake tx: unexpected table");
}

function valueOf(row: Row, col: unknown, keys: Map<unknown, string>): unknown {
  if (col === gauRemainingSql()) {
    return remainingGau(row as unknown as Parameters<typeof remainingGau>[0]);
  }
  const key = keys.get(col);
  if (key === undefined) throw new Error("fake tx: unknown column");
  return row[key];
}

function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number);
  const y = b instanceof Date ? b.getTime() : (b as number);
  return x < y ? -1 : x > y ? 1 : 0;
}

function matches(row: Row, cond: Cond, keys: Map<unknown, string>): boolean {
  switch (cond.op) {
    case "and":
      return cond.conds.every((c) => matches(row, c, keys));
    case "isNull":
      return valueOf(row, cond.col, keys) === null;
    case "eq":
      return cmp(valueOf(row, cond.col, keys), cond.val) === 0;
    case "lt":
      return cmp(valueOf(row, cond.col, keys), cond.val) < 0;
    case "lte":
      return cmp(valueOf(row, cond.col, keys), cond.val) <= 0;
  }
}

function isSql(v: unknown): v is SQL {
  return typeof v === "object" && v !== null && "queryChunks" in v;
}

/**
 * Evaluates one SET value against a row. The writers use three shapes of SQL
 * — `now()`, `<column> + <integer>` and `<column> + excluded.<column>` — and
 * anything else throws, so a statement the fake does not model fails the
 * test rather than passing on a guess. A plain value is assigned as is.
 */
function evalSet(
  row: Row,
  val: unknown,
  keys: Map<unknown, string>,
  excluded: Row | null,
): unknown {
  if (!isSql(val)) return val;
  let text = "";
  let column: string | null = null;
  for (const chunk of val.queryChunks) {
    if (is(chunk, StringChunk)) {
      text += chunk.value.join("");
      continue;
    }
    const key = keys.get(chunk);
    if (key === undefined || column !== null) {
      throw new Error("fake tx: unsupported SET expression");
    }
    column = key;
    text += "$col";
  }
  text = text.trim();
  if (text === "now()") return new Date();
  const add = /^\$col \+ (?:(\d+)|excluded\.(\w+))$/.exec(text);
  if (add === null || column === null) {
    throw new Error(`fake tx: unsupported SET expression: ${text}`);
  }
  const base = row[column] as number;
  if (add[1] !== undefined) return base + Number(add[1]);
  const excludedKey = bucketKeyByName.get(add[2]!);
  if (excluded === null || excludedKey === undefined) {
    throw new Error(`fake tx: no excluded row for ${text}`);
  }
  return base + (excluded[excludedKey] as number);
}

/**
 * The executor, typed as the `Tx` the writers take. A test seeds rows by
 * pushing onto `store.buckets` / `store.settlements`; `store.log` is the
 * statement log. Reads and writes resolve in one microtask each, so a
 * `Promise.all` of concurrent writers interleaves the way row locks would
 * serialise them.
 */
export function makeFakeGauTx(store: FakeGauStore): Tx {
  return fakeGauExecutor(store) as unknown as Tx;
}

/** The untyped executor, for a test that composes it with another table. */
export function fakeGauExecutor(store: FakeGauStore) {
  const tables = { buckets: store.buckets, settlements: store.settlements };
  const keysFor = (t: "buckets" | "settlements") =>
    t === "buckets" ? bucketKeys : settlementKeys;

  return {
    select: () => ({
      from: (table: unknown) => {
        const t = tableName(table);
        let rows = tables[t].slice();
        const chain = {
          where: (cond: Cond) => {
            rows = rows.filter((r) => matches(r, cond, keysFor(t)));
            return chain;
          },
          orderBy: (order: { _desc: unknown }) => {
            const key = keysFor(t).get(order._desc);
            if (key === undefined) throw new Error("fake tx: unknown column");
            rows = rows.slice().sort((a, b) => cmp(b[key], a[key]));
            return chain;
          },
          limit: (n: number) => {
            store.log.push({ op: "select", table: t });
            return Promise.resolve(rows.slice(0, n));
          },
        };
        return chain;
      },
    }),

    insert: (table: unknown) => ({
      values: (v: Row) => {
        const t = tableName(table);
        const insertPlain = () => {
          const row: Row = {
            id: crypto.randomUUID(),
            createdAt: new Date(),
            updatedAt: new Date(),
            ...v,
          };
          tables[t].push(row);
          store.log.push({ op: "insert", table: t, values: v });
          return Promise.resolve([row]);
        };
        return {
          returning: insertPlain,
          onConflictDoUpdate: (conflict: { target: unknown; set: Row }) => ({
            returning: () => {
              if (t !== "buckets") throw new Error("fake tx: upsert table");
              const target = Array.isArray(conflict.target)
                ? conflict.target
                : [conflict.target];
              // The unique index the statement must name is
              // (org_id, period_start); any other arbiter is a different
              // statement.
              if (
                target.length !== 2 ||
                target[0] !== schema.gauBuckets.orgId ||
                target[1] !== schema.gauBuckets.periodStart
              ) {
                throw new Error(
                  "fake tx: upsert arbiter is not (org_id, period_start)",
                );
              }
              store.log.push({
                op: "upsert",
                table: t,
                values: v,
                set: conflict.set,
              });
              const existing = store.buckets.find(
                (b) =>
                  b.orgId === v.orgId &&
                  cmp(b.periodStart, v.periodStart) === 0,
              );
              if (existing) {
                const next: Row = {};
                for (const [k, val] of Object.entries(conflict.set)) {
                  next[k] = evalSet(existing, val, bucketKeys, v);
                }
                Object.assign(existing, next);
                return Promise.resolve([{ ...existing }]);
              }
              const row: Row = {
                id: crypto.randomUUID(),
                overageInvoicedGau: 0,
                interimSeq: 0,
                topupSeq: 0,
                openTopupSettlementId: null,
                closedAt: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                ...v,
              };
              store.buckets.push(row);
              return Promise.resolve([{ ...row }]);
            },
          }),
        };
      },
    }),

    update: (table: unknown) => ({
      set: (patch: Row) => ({
        where: (cond: Cond) => ({
          returning: (cols?: Record<string, unknown>) => {
            const t = tableName(table);
            const keys = keysFor(t);
            store.log.push({ op: "update", table: t, set: patch });
            const hit = tables[t].filter((r) => matches(r, cond, keys));
            for (const row of hit) {
              const next: Row = {};
              for (const [k, val] of Object.entries(patch)) {
                next[k] = evalSet(row, val, keys, null);
              }
              Object.assign(row, next);
            }
            const projected = hit.map((row) => {
              if (!cols) return { ...row };
              const out: Row = {};
              for (const [alias, col] of Object.entries(cols)) {
                out[alias] = valueOf(row, col, keys);
              }
              return out;
            });
            return Promise.resolve(projected);
          },
        }),
      }),
    }),
  };
}
