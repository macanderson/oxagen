import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@clickhouse/client";
import { requireEnv } from "@oxagen/config/env";
import { clickhouse, closeClickhouse } from "./clickhouse";

/**
 * Create the target database if it doesn't exist. The local docker ClickHouse
 * auto-creates it from CLICKHOUSE_DB, but ClickHouse Cloud does not — and a
 * connection scoped to a database that doesn't exist yet is rejected, so the
 * `CREATE DATABASE` must run through a bootstrap client with no database bound.
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
  });
  try {
    await bootstrap.command({
      query: `CREATE DATABASE IF NOT EXISTS \`${env.CLICKHOUSE_DATABASE}\``,
    });
  } finally {
    await bootstrap.close();
  }
}

function splitStatements(sql: string): string[] {
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

// ClickHouse migrations are idempotent (CREATE IF NOT EXISTS / ADD COLUMN
// IF NOT EXISTS). schema.sql is the canonical desired state; migrations/
// holds versioned ALTERs for existing deployments. Both apply on every run.
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

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  migrate()
    .then(() => closeClickhouse())
    .then(() => {
      process.stdout.write(JSON.stringify({ level: "info", msg: "ClickHouse migration complete" }) + "\n");
      process.exit(0);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        JSON.stringify({ level: "error", msg: "ClickHouse migration failed", err: String(err) }) + "\n",
      );
      process.exit(1);
    });
}
