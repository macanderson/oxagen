/**
 * An in-memory executor for the GAU bucket and settlement writers, for unit
 * tests. It runs the statements gau-bucket.ts and gau-settlements.ts issue
 * — the upsert, the re-checked claim UPDATE, the settlement INSERT, the
 * Checkout grant's session-keyed insert and its payment-method mirror
 * upsert — from their arguments: the bucket upsert's arbiter must be
 * `(org_id, period_start)`, the settlement insert's must be the session id
 * with the partial index's predicate restated, and every SET clause is
 * interpreted, so an overwrite where the writer means an add, or a wrong
 * arbiter, fails the tests that ride on the statement. Every statement is
 * recorded, so a test can assert what was written and that the executor it
 * passed in is the one the function used.
 *
 * Conditions are the plain objects the test's `drizzle-orm` mock builds
 * (`test-utils/gau-conditions.ts`); a column is matched by identity against
 * the real schema, and the two SQL expressions a WHERE carries —
 * `gauRemainingSql()` and `gauUninvoicedSql()` — are evaluated by their
 * documented meaning (the uninvoiced one unfloored, as the SQL is).
 *
 * ── Before you add a test against this seam, read this ──────────────────────
 *
 * A fake that does not refuse what the real thing refuses is not a test
 * double. It is a second implementation with different rules, and every gap
 * between the two is a test that passes for the wrong reason.
 *
 * That is not hypothetical here. Three gaps have been found in this file, each
 * of which had been letting a wrong implementation pass:
 *
 *   1. It did not enforce the tables' CHECK constraints. An implementation
 *      that skipped the reversal clamp stored `purchased_gau = -5000` and went
 *      green; Postgres refuses it outright with
 *      `gau_buckets_counts_non_negative` and would have failed the webhook on
 *      every redelivery. `assertChecks` now mirrors the constraints.
 *   2. A bare `await tx.insert(...).values(...)` did nothing. Drizzle executes
 *      it; the fake returned a builder object, so a row the code really writes
 *      never appeared in the store — which reads as "the code did not write
 *      it" in a test that checks, and as a pass in every test that does not.
 *   3. `select().from().where()` resolved only on `.limit()`. Drizzle runs the
 *      query at every stage, so an unlimited read awaited the chain object and
 *      the caller got something that was not an array.
 *
 * The pattern is one-directional: each gap made the fake *more permissive*
 * than Postgres, never less. So when you add a statement shape here, ask what
 * the database would reject that this would accept — and prefer throwing on
 * anything unmodelled (as `evalSet` and the arbiter checks already do) over
 * guessing, because a guess is indistinguishable from a pass.
 */

import { getTableColumns, is, Param, StringChunk, type SQL } from "drizzle-orm";
import { schema, type Tx } from "@oxagen/database";
import {
  gauRemainingSql,
  gauUninvoicedSql,
  remainingGau,
  uninvoicedGau,
} from "../gau-bucket";
import type { Cond } from "./gau-conditions";

type Row = Record<string, unknown>;

export interface StatementLog {
  op: "select" | "insert" | "upsert" | "update" | "lock";
  table: string;
  values?: Row;
  set?: Row;
  /** For `op: "lock"`, the advisory-lock key the statement named. */
  lockKey?: string;
}

export interface FakeGauStore {
  buckets: Row[];
  settlements: Row[];
  reversals: Row[];
  paymentMethods: Row[];
  /** billing.gau_ledger (ADR-158): one row per billed governed action. */
  ledger: Row[];
  log: StatementLog[];
}

export function makeFakeGauStore(): FakeGauStore {
  return {
    buckets: [],
    settlements: [],
    reversals: [],
    paymentMethods: [],
    ledger: [],
    log: [],
  };
}

type TableName =
  | "buckets"
  | "settlements"
  | "reversals"
  | "paymentMethods"
  | "ledger";

function columnKeys(table: Parameters<typeof getTableColumns>[0]) {
  return new Map<unknown, string>(
    Object.entries(getTableColumns(table)).map(([k, c]) => [c, k]),
  );
}
const bucketKeys = columnKeys(schema.gauBuckets);
const settlementKeys = columnKeys(schema.gauSettlements);
const reversalKeys = columnKeys(schema.gauReversals);
const paymentMethodKeys = columnKeys(schema.paymentMethods);
const ledgerKeys = columnKeys(schema.gauLedger);
/** `used_gau` → `usedGau`, for the `excluded.<column>` reference a SET carries. */
const bucketKeyByName = new Map<string, string>(
  Object.entries(getTableColumns(schema.gauBuckets)).map(([k, c]) => [
    c.name,
    k,
  ]),
);

function tableName(table: unknown): TableName {
  if (table === schema.gauBuckets) return "buckets";
  if (table === schema.gauSettlements) return "settlements";
  if (table === schema.gauReversals) return "reversals";
  if (table === schema.paymentMethods) return "paymentMethods";
  if (table === schema.gauLedger) return "ledger";
  throw new Error("fake tx: unexpected table");
}

function valueOf(row: Row, col: unknown, keys: Map<unknown, string>): unknown {
  if (col === gauRemainingSql()) {
    return remainingGau(row as unknown as Parameters<typeof remainingGau>[0]);
  }
  if (col === gauUninvoicedSql()) {
    const b = row as unknown as Parameters<typeof uninvoicedGau>[0];
    return (
      b.usedGau -
      b.includedGau -
      b.purchasedGau -
      b.carriedGau -
      b.overageInvoicedGau
    );
  }
  const key = keys.get(col);
  if (key === undefined) throw new Error("fake tx: unknown column");
  return row[key];
}

function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number | string);
  const y = b instanceof Date ? b.getTime() : (b as number | string);
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
    case "ne":
      return cmp(valueOf(row, cond.col, keys), cond.val) !== 0;
    case "lt":
      return cmp(valueOf(row, cond.col, keys), cond.val) < 0;
    case "lte":
      return cmp(valueOf(row, cond.col, keys), cond.val) <= 0;
    case "gt":
      return cmp(valueOf(row, cond.col, keys), cond.val) > 0;
    case "gte":
      return cmp(valueOf(row, cond.col, keys), cond.val) >= 0;
  }
}

/**
 * The table CHECK constraints a write has to satisfy, enforced here because a
 * fake that accepts what Postgres refuses proves nothing. `gau_buckets`
 * forbids a negative count, which is what makes the reversal's clamp
 * load-bearing rather than cosmetic; `gau_reversals` requires its three
 * quantities to add up.
 */
function assertChecks(t: TableName, row: Row): void {
  if (t === "buckets") {
    for (const k of [
      "includedGau",
      "purchasedGau",
      "carriedGau",
      "usedGau",
      "overageInvoicedGau",
      "interimSeq",
      "topupSeq",
    ] as const) {
      const v = row[k];
      if (typeof v === "number" && v < 0) {
        throw new Error(
          `fake tx: violates gau_buckets_counts_non_negative (${k} = ${v})`,
        );
      }
    }
    return;
  }
  if (t === "reversals") {
    const requested = row.requestedGau as number;
    const reversed = row.reversedGau as number;
    const unrecovered = row.unrecoveredGau as number;
    const amount = row.amountCents as number;
    if (
      requested < 0 ||
      reversed < 0 ||
      unrecovered < 0 ||
      amount < 0 ||
      reversed + unrecovered !== requested
    ) {
      throw new Error("fake tx: violates gau_reversals_quantities_check");
    }
    if (row.kind !== "refund" && row.kind !== "dispute") {
      throw new Error("fake tx: violates gau_reversals_kind_check");
    }
    // Pending or settled, never half of each.
    if ((row.settlementId === null) !== (row.bucketId === null)) {
      throw new Error(
        "fake tx: violates gau_reversals_pending_consistency_check",
      );
    }
    return;
  }
  if (t === "ledger") {
    if (!Number.isInteger(row.units) || (row.units as number) <= 0) {
      throw new Error("fake tx: violates gau_ledger_units_positive");
    }
    if (!["kernel", "tacho", "external_tool"].includes(row.source as string)) {
      throw new Error("fake tx: violates gau_ledger_source_check");
    }
    if (row.capability == null && row.toolName == null) {
      throw new Error("fake tx: violates gau_ledger_subject_check");
    }
    if (typeof row.bucketId !== "string") {
      throw new Error("fake tx: gau_ledger.bucket_id is NOT NULL");
    }
    return;
  }
}

function isSql(v: unknown): v is SQL {
  return typeof v === "object" && v !== null && "queryChunks" in v;
}

/**
 * Evaluates one SET value against a row. The writers use three shapes of SQL
 * — `now()`, `<column> + <integer>` (a literal or a bound parameter) and
 * `<column> + excluded.<column>` — and
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
    // A bound integer: drizzle keeps a template value as is, or as a Param.
    const bound = is(chunk, Param) ? chunk.value : chunk;
    if (typeof bound === "number" && Number.isInteger(bound)) {
      text += String(bound);
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
 * Whether an ON CONFLICT arbiter on a partial unique index restates the
 * index's predicate: the settlement insert must say `WHERE
 * stripe_checkout_session_id IS NOT NULL`, or Postgres finds no matching
 * index and the statement errors at runtime.
 */
function restatesNotNull(where: unknown, col: unknown): boolean {
  if (!isSql(where)) return false;
  let text = "";
  let sawColumn = false;
  for (const chunk of where.queryChunks) {
    if (is(chunk, StringChunk)) text += chunk.value.join("");
    else if (chunk === col) sawColumn = true;
  }
  return sawColumn && /\bIS NOT NULL\b/i.test(text);
}

/** A write drizzle lets the caller await directly or chain `.returning()` on. */
function thenable<T>(run: () => T) {
  return {
    returning: () => Promise.resolve(run()),
    then: <R>(onFulfilled: (v: T) => R) =>
      Promise.resolve(run()).then(onFulfilled),
  };
}

/**
 * The executor, typed as the `Tx` the writers take. A test seeds rows by
 * pushing onto `store.buckets` / `store.settlements` / `store.paymentMethods`;
 * `store.log` is the statement log. Reads and writes resolve in one microtask
 * each, so a `Promise.all` of concurrent writers interleaves the way row
 * locks would serialise them.
 */
export function makeFakeGauTx(store: FakeGauStore): Tx {
  return fakeGauExecutor(store) as unknown as Tx;
}

/** The untyped executor, for a test that composes it with another table. */
export function fakeGauExecutor(store: FakeGauStore) {
  const tables: Record<TableName, Row[]> = {
    buckets: store.buckets,
    settlements: store.settlements,
    reversals: store.reversals,
    paymentMethods: store.paymentMethods,
    ledger: store.ledger,
  };
  const keysFor = (t: TableName) =>
    t === "buckets"
      ? bucketKeys
      : t === "settlements"
        ? settlementKeys
        : t === "reversals"
          ? reversalKeys
          : t === "ledger"
            ? ledgerKeys
            : paymentMethodKeys;

  /**
   * `INSERT INTO billing.gau_ledger … VALUES (…), (…) ON CONFLICT (org_id,
   * idempotency_key) DO NOTHING RETURNING …`. The only statement shape the
   * ledger writer issues, so it is the only one modelled: a single-row
   * insert, a bare insert or any other arbiter throws. Two rows with one key
   * in the same statement raise in Postgres (a command cannot affect a row a
   * second time), so they raise here too.
   */
  const ledgerInsert = (input: Row | Row[]) => {
    if (!Array.isArray(input)) {
      throw new Error("fake tx: the ledger writer inserts an array of rows");
    }
    const refuse = () => {
      throw new Error("fake tx: ledger insert must be ON CONFLICT DO NOTHING");
    };
    return {
      returning: refuse,
      then: refuse,
      onConflictDoNothing: (conflict: { target: unknown }) => {
        const target = Array.isArray(conflict.target)
          ? conflict.target
          : [conflict.target];
        if (
          target.length !== 2 ||
          target[0] !== schema.gauLedger.orgId ||
          target[1] !== schema.gauLedger.idempotencyKey
        ) {
          throw new Error(
            "fake tx: ledger arbiter is not (org_id, idempotency_key)",
          );
        }
        const run = (): Row[] => {
          const keys = new Set<string>();
          for (const v of input) {
            const k = `${v.orgId as string}|${v.idempotencyKey as string}`;
            if (keys.has(k)) {
              throw new Error(
                "fake tx: ON CONFLICT DO UPDATE command cannot affect row a second time",
              );
            }
            keys.add(k);
          }
          const out: Row[] = [];
          for (const v of input) {
            const dup = store.ledger.some(
              (r) =>
                r.orgId === v.orgId && r.idempotencyKey === v.idempotencyKey,
            );
            store.log.push({ op: "insert", table: "ledger", values: v });
            if (dup) continue;
            const row: Row = { id: crypto.randomUUID(), ...v };
            assertChecks("ledger", row);
            store.ledger.push(row);
            out.push(row);
          }
          return out;
        };
        return {
          returning: (cols?: Record<string, unknown>) =>
            Promise.resolve(
              run().map((row) => {
                if (!cols) return { ...row };
                const o: Row = {};
                for (const [alias, col] of Object.entries(cols)) {
                  o[alias] = valueOf(row, col, ledgerKeys);
                }
                return o;
              }),
            ),
          then: <R>(onFulfilled: (v: Row[]) => R) =>
            Promise.resolve(run()).then(onFulfilled),
        };
      },
    };
  };

  return {
    query: {
      paymentMethods: {
        findFirst: (args: { where: Cond }) => {
          store.log.push({ op: "select", table: "paymentMethods" });
          const hit = store.paymentMethods.find((r) =>
            matches(r, args.where, paymentMethodKeys),
          );
          return Promise.resolve(hit ? { ...hit } : undefined);
        },
      },
      gauSettlements: {
        findFirst: (args: { where: Cond }) => {
          store.log.push({ op: "select", table: "settlements" });
          const hit = store.settlements.find((r) =>
            matches(r, args.where, settlementKeys),
          );
          return Promise.resolve(hit ? { ...hit } : undefined);
        },
      },
      gauReversals: {
        findFirst: (args: { where: Cond }) => {
          store.log.push({ op: "select", table: "reversals" });
          const hit = store.reversals.find((r) =>
            matches(r, args.where, reversalKeys),
          );
          return Promise.resolve(hit ? { ...hit } : undefined);
        },
      },
    },

    select: () => ({
      from: (table: unknown) => {
        const t = tableName(table);
        let rows = tables[t].slice();
        const chain = {
          where: (cond: Cond) => {
            rows = rows.filter((r) => matches(r, cond, keysFor(t)));
            return chain;
          },
          orderBy: (order: { _desc?: unknown; _asc?: unknown }) => {
            const descending = "_desc" in order;
            const key = keysFor(t).get(descending ? order._desc : order._asc);
            if (key === undefined) throw new Error("fake tx: unknown column");
            rows = rows
              .slice()
              .sort((a, b) =>
                descending ? cmp(b[key], a[key]) : cmp(a[key], b[key]),
              );
            return chain;
          },
          limit: (n: number) => {
            store.log.push({ op: "select", table: t });
            return Promise.resolve(rows.slice(0, n));
          },
          // A select is thenable at every stage in drizzle — `await
          // tx.select().from(x).where(y)` with no limit runs the query. The
          // fake used to resolve only on `.limit()`, so an unlimited read
          // awaited the chain object itself and the caller got something that
          // was not an array.
          then: <R>(onFulfilled: (v: Row[]) => R) => {
            store.log.push({ op: "select", table: t });
            return Promise.resolve(rows.map((r) => ({ ...r }))).then(
              onFulfilled,
            );
          },
        };
        return chain;
      },
    }),

    insert: (table: unknown) => ({
      values: (input: Row | Row[]) => {
        const t = tableName(table);
        if (t === "ledger") return ledgerInsert(input);
        if (Array.isArray(input)) {
          throw new Error(
            "fake tx: multi-row insert is modelled only for the ledger",
          );
        }
        const v = input;
        const insertRow = (): Row => {
          const row: Row = {
            id: crypto.randomUUID(),
            createdAt: new Date(),
            updatedAt: new Date(),
            // The nullable settlement columns an insert leaves out are NULL.
            ...(t === "settlements"
              ? {
                  stripeCheckoutSessionId: null,
                  stripeInvoiceId: null,
                  stripePaymentIntentId: null,
                  chargedCents: null,
                  settledAt: null,
                }
              : {}),
            ...(t === "reversals"
              ? { settlementId: null, bucketId: null }
              : {}),
            ...v,
          };
          assertChecks(t, row);
          if (
            t === "reversals" &&
            store.reversals.some(
              (r) =>
                r.stripePaymentIntentId === row.stripePaymentIntentId &&
                r.providerEventId === row.providerEventId,
            )
          ) {
            // gau_reversals_payment_intent_event_idx: the idempotency key.
            throw new Error(
              "fake tx: duplicate key value violates gau_reversals_payment_intent_event_idx",
            );
          }
          tables[t].push(row);
          store.log.push({ op: "insert", table: t, values: v });
          return row;
        };
        return {
          returning: () => Promise.resolve([insertRow()]),
          // A bare `await tx.insert(...).values(...)` executes in drizzle, so
          // it has to execute here: an insert the fake silently skipped would
          // read as "the row was never written" in every test that checks for
          // it, and as a pass in every test that does not.
          then: <R>(onFulfilled: (v: Row[]) => R) =>
            Promise.resolve([insertRow()]).then(onFulfilled),
          onConflictDoNothing: (conflict: { target: unknown; where?: SQL }) =>
            thenable(() => {
              if (t !== "settlements") {
                throw new Error("fake tx: do-nothing insert table");
              }
              if (
                conflict.target !==
                schema.gauSettlements.stripeCheckoutSessionId
              ) {
                throw new Error(
                  "fake tx: settlement arbiter is not stripe_checkout_session_id",
                );
              }
              if (!restatesNotNull(conflict.where, conflict.target)) {
                throw new Error(
                  "fake tx: settlement arbiter does not restate the partial index predicate",
                );
              }
              const duplicate = store.settlements.some(
                (r) =>
                  r.stripeCheckoutSessionId !== null &&
                  r.stripeCheckoutSessionId === v.stripeCheckoutSessionId,
              );
              if (duplicate) {
                store.log.push({ op: "insert", table: t, values: v });
                return [];
              }
              return [insertRow()];
            }),
          onConflictDoUpdate: (conflict: { target: unknown; set: Row }) =>
            thenable(() => {
              if (t === "paymentMethods") {
                if (
                  conflict.target !==
                  schema.paymentMethods.stripePaymentMethodId
                ) {
                  throw new Error(
                    "fake tx: payment method arbiter is not stripe_payment_method_id",
                  );
                }
                store.log.push({
                  op: "upsert",
                  table: t,
                  values: v,
                  set: conflict.set,
                });
                const existing = store.paymentMethods.find(
                  (r) => r.stripePaymentMethodId === v.stripePaymentMethodId,
                );
                if (existing) {
                  const next: Row = {};
                  for (const [k, val] of Object.entries(conflict.set)) {
                    next[k] = evalSet(existing, val, paymentMethodKeys, v);
                  }
                  Object.assign(existing, next);
                  return [{ ...existing }];
                }
                const row: Row = {
                  id: crypto.randomUUID(),
                  deletedAt: null,
                  deletedById: null,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  ...v,
                };
                store.paymentMethods.push(row);
                return [{ ...row }];
              }
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
                assertChecks("buckets", { ...existing, ...next });
                Object.assign(existing, next);
                return [{ ...existing }];
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
              return [{ ...row }];
            }),
        };
      },
    }),

    /**
     * `tx.execute(sql\`…\`)`. Only the advisory lock is modelled, and only as
     * a RECORD that it was taken — a single-threaded in-memory store cannot
     * exhibit what the lock exists to prevent, so a test here can prove the
     * statement is issued and nothing about whether it serialises anything.
     * The serialisation itself is proved against real Postgres on two
     * connections in `gau-reversals.concurrency.integration.test.ts`; treating
     * this log entry as proof of correctness would be the mock-fidelity trap
     * this file's header warns about. Anything else throws rather than
     * silently succeeding.
     */
    execute: (stmt: unknown) => {
      let text = "";
      let key: string | undefined;
      if (isSql(stmt)) {
        for (const chunk of stmt.queryChunks) {
          if (is(chunk, StringChunk)) text += chunk.value.join("");
          else {
            const bound = is(chunk, Param) ? chunk.value : chunk;
            if (typeof bound === "string") key = bound;
          }
        }
      }
      if (!/pg_advisory_xact_lock/.test(text)) {
        throw new Error(`fake tx: unmodelled execute(): ${text.trim()}`);
      }
      store.log.push({ op: "lock", table: "-", lockKey: key });
      return Promise.resolve([]);
    },

    update: (table: unknown) => ({
      set: (patch: Row) => ({
        where: (cond: Cond) => {
          const run = (cols?: Record<string, unknown>) => {
            const t = tableName(table);
            const keys = keysFor(t);
            store.log.push({ op: "update", table: t, set: patch });
            const hit = tables[t].filter((r) => matches(r, cond, keys));
            for (const row of hit) {
              const next: Row = {};
              for (const [k, val] of Object.entries(patch)) {
                next[k] = evalSet(row, val, keys, null);
              }
              assertChecks(t, { ...row, ...next });
              Object.assign(row, next);
            }
            return hit.map((row) => {
              if (!cols) return { ...row };
              const out: Row = {};
              for (const [alias, col] of Object.entries(cols)) {
                out[alias] = valueOf(row, col, keys);
              }
              return out;
            });
          };
          return {
            returning: (cols?: Record<string, unknown>) =>
              Promise.resolve(run(cols)),
            then: <R>(onFulfilled: (v: Row[]) => R) =>
              Promise.resolve(run()).then(onFulfilled),
          };
        },
      }),
    }),
  };
}
