/**
 * An in-memory executor for the GAU bucket and settlement writers, for unit
 * tests. It mirrors the statements gau-bucket.ts and gau-settlements.ts issue
 * — the `(org_id, period_start)` upsert-add, the re-checked claim UPDATE, the
 * settlement INSERT — and records every statement it runs, so a test can
 * assert what was written and that the executor it passed in is the one the
 * function used.
 *
 * Conditions are the plain objects the test's `drizzle-orm` mock builds
 * (`test-utils/gau-conditions.ts`); a column is matched by identity against
 * the real schema, and the one SQL expression a WHERE carries —
 * `GAU_REMAINING_SQL` — is evaluated by its documented meaning.
 */

import { getTableColumns, type SQL } from "drizzle-orm";
import { schema, type Tx } from "@oxagen/database";
import { GAU_REMAINING_SQL, remainingGau } from "../gau-bucket";
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

function tableName(table: unknown): "buckets" | "settlements" {
  if (table === schema.gauBuckets) return "buckets";
  if (table === schema.gauSettlements) return "settlements";
  throw new Error("fake tx: unexpected table");
}

function valueOf(row: Row, col: unknown, keys: Map<unknown, string>): unknown {
  if (col === GAU_REMAINING_SQL) {
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
          onConflictDoUpdate: (_conflict: { target: unknown; set: Row }) => ({
            returning: () => {
              if (t !== "buckets") throw new Error("fake tx: upsert table");
              store.log.push({ op: "upsert", table: t, values: v });
              const existing = store.buckets.find(
                (b) =>
                  b.orgId === v.orgId &&
                  cmp(b.periodStart, v.periodStart) === 0,
              );
              if (existing) {
                // DO UPDATE SET used_gau = used_gau + EXCLUDED.used_gau,
                //               purchased_gau = purchased_gau + EXCLUDED.purchased_gau
                existing.usedGau =
                  (existing.usedGau as number) + (v.usedGau as number);
                existing.purchasedGau =
                  (existing.purchasedGau as number) +
                  (v.purchasedGau as number);
                existing.updatedAt = new Date();
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
              for (const [k, val] of Object.entries(patch)) {
                if (isSql(val)) {
                  // The two SQL patches the writers use: `topup_seq + 1`
                  // and `now()`.
                  row[k] =
                    k === "topupSeq" ? (row[k] as number) + 1 : new Date();
                } else {
                  row[k] = val;
                }
              }
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
