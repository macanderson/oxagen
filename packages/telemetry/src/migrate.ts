import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clickhouse, closeClickhouse } from "./clickhouse.js";

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
      console.log("ClickHouse migration complete");
      process.exit(0);
    })
    .catch((err) => {
      console.error("ClickHouse migration failed:", err);
      process.exit(1);
    });
}
