import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { requireEnv } from "@oxagen/config/env";
import * as schema from "./schema/index";

// One pool per process, sized by runtime: 20 connections in production, 5
// locally so the Docker Postgres stays happy.
//
// 20 is a PER-PROCESS cap, not a global one. Production Postgres is RDS/Aurora
// (see the migration notes in atlas/migrations — the connecting role is
// rds_superuser, never a true superuser), whose `max_connections` is fixed by
// instance class, so the real ceiling is 20 x the number of concurrently warm
// serverless instances. Keep a connection pooler (RDS Proxy or equivalent) in
// front of the writer endpoint, or lower this number, before scaling instance
// count.
let _client: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function db() {
  if (_db) return _db;
  const env = requireEnv(["DATABASE_URL", "NODE_ENV"] as const);
  _client = postgres(env.DATABASE_URL, {
    max: env.NODE_ENV === "production" ? 20 : 5,
    prepare: false,
  });
  _db = drizzle(_client, { schema, casing: "snake_case" });
  return _db;
}

export type Database = ReturnType<typeof db>;

/**
 * Close the pool and reset the singleton. Idempotent — a no-op when no pool has
 * been created.
 *
 * The reset is in a `finally` so a rejecting `end()` (a socket already gone, a
 * connection that will not drain within the timeout) still clears the
 * singleton. Leaving a dead handle in `_client` would make the next `db()`
 * return a Drizzle instance over a closed pool, and every subsequent
 * `closeDatabase()` retry throw against the same corpse.
 */
export async function closeDatabase(): Promise<void> {
  const client = _client;
  if (!client) return;
  try {
    await client.end({ timeout: 5 });
  } finally {
    _client = null;
    _db = null;
  }
}
