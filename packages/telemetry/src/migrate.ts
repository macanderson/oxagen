import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
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

// ── Applied-migrations ledger (#2632) ─────────────────────────────────────────
//
// `_migrations` matches the name this very monorepo's Postgres runner used for
// the identical job before it was replaced by Atlas — see
// packages/database/atlas.hcl's `exclude = ["atlas_schema_revisions",
// "_migrations"]` and packages/database/drizzle/README.md. ClickHouse's runner
// never grew the equivalent table; this gives it the one this repo already
// had a name for, rather than inventing a new one.
const LEDGER_TABLE = "_migrations";

/**
 * The last `migrations/*.sql` filename that exists as of the PR introducing
 * this ledger (#2632), in the same lexicographic order `migrate()` applies
 * them. Every environment that has ever run `migrate()` before this change
 * has already applied every file up to and including this one — repeatedly,
 * on every deploy, under the old replay-everything semantics — so the
 * bootstrap in `migrate()` below marks exactly this file and everything
 * before it as already applied, WITHOUT re-executing them, the first time it
 * finds an empty ledger in a database that already has other tables. That
 * one skip is what stops the deploy shipping this fix from
 * performing 0021's `DROP TABLE` one more time — the last occurrence of the
 * exact data loss this ledger exists to end.
 *
 * Do NOT bump this constant when adding a new migration file. It is a
 * one-time cutover marker for the pre-ledger backlog, not a "latest
 * migration" pointer: a filename that sorts AFTER it is — by construction —
 * one this constant's author never saw, so it is never swept into the
 * baseline and always executes for real, INCLUDING against an existing
 * deployment, even one upgrading to this ledger in the same deploy that adds
 * the new file.
 */
const PRE_LEDGER_BASELINE_CUTOVER = "0026_stella_operational_events.sql";

async function ensureLedgerTable(ch: ClickHouseClient): Promise<void> {
  await ch.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE}
      (
          filename    String,
          applied_at  DateTime64(3) DEFAULT now64(3)
      )
      ENGINE = MergeTree
      ORDER BY filename
    `,
  });
}

/**
 * True when the target database already contains at least one table OTHER
 * than the ledger. Called BEFORE `ensureLedgerTable` creates `_migrations`,
 * so the ledger table itself never counts. This is the fresh-install /
 * existing-deployment fork: a genuinely empty database has never run any
 * migration, so every file must still execute in full (0021's `DROP TABLE
 * IF EXISTS` is a no-op against a table that was never created); a database
 * that already has tables reached that state through a PRIOR successful
 * `migrate()` run — a failed one would have thrown and failed the deploy —
 * so every migration file present at that time is known-applied.
 */
async function databaseHasPreExistingTables(
  ch: ClickHouseClient,
): Promise<boolean> {
  const result = await ch.query({
    query: `SELECT count() AS c FROM system.tables WHERE database = currentDatabase()`,
    format: "JSONEachRow",
  });
  const rows = await result.json<{ c: string }>();
  return Number(rows[0]?.c ?? "0") > 0;
}

/** Filenames already recorded in the ledger. */
async function appliedMigrations(ch: ClickHouseClient): Promise<Set<string>> {
  const result = await ch.query({
    query: `SELECT DISTINCT filename FROM ${LEDGER_TABLE}`,
    format: "JSONEachRow",
  });
  const rows = await result.json<{ filename: string }>();
  return new Set(rows.map((r) => r.filename));
}

async function recordApplied(
  ch: ClickHouseClient,
  filenames: readonly string[],
): Promise<void> {
  if (filenames.length === 0) return;
  await ch.insert({
    table: LEDGER_TABLE,
    values: filenames.map((filename) => ({ filename })),
    format: "JSONEachRow",
  });
}

// Applies schema.sql on every call (it is fully idempotent — CREATE TABLE /
// ADD COLUMN IF NOT EXISTS, no DROP), then every NOT-YET-APPLIED file in
// migrations/ in filename order, recording each one in the `_migrations`
// ledger as it completes so it is never re-executed by a later call.
//
// Before this ledger existed, EVERY statement in migrations/ replayed on
// EVERY call. That made each statement's own idempotency the only thing
// keeping a re-run safe (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT
// EXISTS), and nothing checked it — a non-idempotent statement re-executed on
// every deploy. `DROP TABLE IF EXISTS` is idempotent as a statement but was
// NOT safe under replay when the same file recreates the table under the same
// name (0021): it destroyed schema_conformance_events's data every run. A
// `DROP TABLE IF EXISTS` with nothing recreating that name (0007, 0010, dead
// tables with zero readers/writers) was always replay-safe and stays
// unguarded by the ledger — dropping an already-dropped table is a genuine
// no-op, not data loss.
//
// schema.sql holds most, but not all, table definitions — audit_events,
// error_events, usage_events, memory_changes, schema_conformance_events,
// stella_operational_events and the claude_* tables are defined only in
// migrations/. Treat schema.sql plus migrations/ together as the desired state.
export async function migrate(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  await ensureDatabase();
  const ch = clickhouse();

  // Snapshot taken BEFORE the ledger table exists, so it can never see itself.
  const isExistingDeployment = await databaseHasPreExistingTables(ch);
  await ensureLedgerTable(ch);

  const schemaSql = readFileSync(join(here, "schema.sql"), "utf8");
  for (const stmt of splitStatements(schemaSql)) {
    await ch.command({ query: stmt });
  }

  const migrationsDir = join(here, "migrations");
  if (existsSync(migrationsDir)) {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied = await appliedMigrations(ch);

    // One-time bootstrap: an existing deployment upgrading to this ledger has
    // already applied everything up to the pre-ledger cutover, repeatedly —
    // record that WITHOUT re-running it. See PRE_LEDGER_BASELINE_CUTOVER for
    // why a file that sorts after the cutover is deliberately excluded here
    // and always runs for real below.
    if (isExistingDeployment && applied.size === 0) {
      const baseline = files.filter((f) => f <= PRE_LEDGER_BASELINE_CUTOVER);
      await recordApplied(ch, baseline);
      for (const f of baseline) applied.add(f);
    }

    for (const file of files) {
      if (applied.has(file)) continue;
      const body = readFileSync(join(migrationsDir, file), "utf8");
      for (const stmt of splitStatements(body)) {
        await ch.command({ query: stmt });
      }
      await recordApplied(ch, [file]);
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
