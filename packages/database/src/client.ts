import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { requireEnv } from "@oxagen/config/env";
import * as schema from "./schema/index";

// One pool per process. Neon's pooled URL handles concurrency upstream
// for production; locally we cap small to keep Docker happy.
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

export async function closeDatabase(): Promise<void> {
  if (_client) {
    await _client.end({ timeout: 5 });
    _client = null;
    _db = null;
  }
}
