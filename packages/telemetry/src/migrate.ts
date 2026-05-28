import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clickhouse, closeClickhouse } from "./clickhouse.js";

// ClickHouse migrations are CREATE IF NOT EXISTS statements; re-running
// the file is a no-op. Each statement runs independently so a partial
// failure surfaces the offending DDL.
export async function migrate(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  const statements = sql
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));

  const ch = clickhouse();
  for (const stmt of statements) {
    await ch.command({ query: stmt });
  }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  migrate()
    .then(() => closeClickhouse())
    .then(() => {
      // eslint-disable-next-line no-console
      console.log("ClickHouse migration complete");
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("ClickHouse migration failed:", err);
      process.exit(1);
    });
}
