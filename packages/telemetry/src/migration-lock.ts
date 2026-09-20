import postgres from "postgres";
import { requireEnv } from "@oxagen/config/env";

/**
 * Serialize ClickHouse migrations across processes using the shared Postgres
 * database. The fixed key also covers alternate URLs for the same server.
 * This connection takes a lock only. It never reads tenant tables. Importing
 * @oxagen/database here would create a database -> telemetry -> database cycle.
 */
export async function withMigrationLock<T>(run: () => Promise<T>): Promise<T> {
  const { DATABASE_URL } = requireEnv(["DATABASE_URL"] as const);
  const connection = postgres(DATABASE_URL, { max: 1, prepare: false });
  try {
    return (await connection.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(1869768558, 2687)`;
      return run();
    })) as T;
  } finally {
    await connection.end({ timeout: 5 });
  }
}
