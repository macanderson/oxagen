import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@clickhouse/client";
import { requireEnv } from "@oxagen/config/env";
import { clickhouse, closeClickhouse } from "./clickhouse";
import { isDirectRunEntry } from "./is-direct-run";

/** Sleep helper for the cold-start retry loop. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Create the target database if it doesn't exist. The local docker ClickHouse
 * auto-creates it from CLICKHOUSE_DB, but ClickHouse Cloud does not — and a
 * connection scoped to a database that doesn't exist yet is rejected, so the
 * `CREATE DATABASE` must run through a bootstrap client with no database bound.
 *
 * ClickHouse Cloud auto-pauses idle services; the first connection wakes the
 * service, which can take longer than the default 30s request timeout. So this
 * is the first CH contact of the migrate run: use a longer per-attempt timeout
 * and retry on transient connection/timeout errors so a cold-start wake-up
 * doesn't fail the deploy. A genuinely-unreachable service still fails after
 * the retries (surfacing the real problem rather than hiding it).
 */
async function ensureDatabase(): Promise<void> {
  const env = requireEnv([
    "CLICKHOUSE_URL",
    "CLICKHOUSE_USERNAME",
    "CLICKHOUSE_PASSWORD",
    "CLICKHOUSE_DATABASE",
  ] as const);
  const bootstrap = createClient({
    url: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_USERNAME,
    password: env.CLICKHOUSE_PASSWORD,
    request_timeout: 60_000,
  });
  const attempts = 5;
  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await bootstrap.command({
          query: `CREATE DATABASE IF NOT EXISTS \`${env.CLICKHOUSE_DATABASE}\``,
        });
        return;
      } catch (err) {
        if (attempt === attempts) throw err;
        process.stderr.write(
          JSON.stringify({
            level: "warn",
            msg: `ClickHouse not ready (attempt ${attempt}/${attempts}) — likely a Cloud cold-start; retrying`,
            err: err instanceof Error ? err.message : String(err),
          }) + "\n",
        );
        await delay(15_000);
      }
    }
  } finally {
    await bootstrap.close();
  }
}

export function splitStatements(sql: string): string[] {
  // Strip leading comment lines per chunk so a statement preceded by
  // commentary still executes.
  return sql
    .split(/;\s*$/m)
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
}

// Applies schema.sql, then every file in migrations/ in filename order.
//
// There is no applied-migrations ledger: EVERY statement replays on EVERY run.
// That makes each statement's own idempotency the only thing keeping a re-run
// safe (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), and it is not
// checked by anything — a non-idempotent statement in migrations/ re-executes
// on every deploy. `DROP TABLE IF EXISTS` is idempotent as a statement but NOT
// safe under replay: it destroys the table's data every run.
//
// schema.sql holds most, but not all, table definitions — audit_events,
// error_events, usage_events, memory_changes, schema_conformance_events,
// stella_operational_events and the claude_* tables are defined only in
// migrations/. Treat schema.sql plus migrations/ together as the desired state.
export async function migrate(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  await ensureDatabase();
  const ch = clickhouse();

  const schemaSql = readFileSync(join(here, "schema.sql"), "utf8");
  for (const stmt of splitStatements(schemaSql)) {
    await ch.command({ query: stmt });
  }

  const migrationsDir = join(here, "migrations");
  if (existsSync(migrationsDir)) {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const body = readFileSync(join(migrationsDir, file), "utf8");
      for (const stmt of splitStatements(body)) {
        await ch.command({ query: stmt });
      }
    }
  }
}

// Bundle-safe direct-run guard (see is-direct-run.ts): the bare
// import.meta.url === file://argv[1] equality misfires inside the standalone
// `oxagen` bundle and would run this ClickHouse migration → process.exit(1) on
// every CLI boot, crashing any run without CLICKHOUSE_* env.
if (isDirectRunEntry(import.meta.url, process.argv[1], "migrate")) {
  migrate()
    .then(() => closeClickhouse())
    .then(() => {
      process.stdout.write(
        JSON.stringify({
          level: "info",
          msg: "ClickHouse migration complete",
        }) + "\n",
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        JSON.stringify({
          level: "error",
          msg: "ClickHouse migration failed",
          err: String(err),
        }) + "\n",
      );
      process.exit(1);
    });
}
