// Unscoped ClickHouse primitives for the `bench` database — Oxagen's own
// internal benchmark tracking (packages/bench/migrations/0001_bench_schema.sql),
// not tenant/product data. There is no org_id/workspace_id concept for a
// benchmark run, so these intentionally bypass chInsert/chSelect's
// tenant-scope stamping and guard (./tenant.ts) — see that file's own doc
// comment: "A query that genuinely must run unscoped must use the raw
// clickhouse() client directly inside packages/telemetry — not this helper."
//
// @oxagen/bench is the sole external consumer. A lint rule forbids it from
// importing `clickhouse` directly, so it calls these thin, tenant-free
// wrappers instead.
import { clickhouse } from "./clickhouse";

/** Batched JSONEachRow insert into a fully-qualified `bench.<table>` name. No-ops on an empty array. */
export async function chBenchInsert<T extends object>(
  table: string,
  rows: ReadonlyArray<T>,
): Promise<void> {
  if (rows.length === 0) return;
  await clickhouse().insert({ table, values: rows, format: "JSONEachRow" });
}

/** Runs a `bench.*` query and returns the JSONEachRow rows, typed by the caller. */
export async function chBenchQuery<T>(
  query: string,
  query_params: Record<string, unknown> = {},
): Promise<T[]> {
  const result = await clickhouse().query({
    query,
    query_params,
    format: "JSONEachRow",
  });
  return (await result.json()) as T[];
}

/** Runs a DDL/DML statement with no result set (CREATE DATABASE/TABLE, ALTER, ...) — for @oxagen/bench's migrate script. */
export async function chBenchCommand(query: string): Promise<void> {
  await clickhouse().command({ query });
}
