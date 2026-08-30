#!/usr/bin/env tsx
/**
 * Applies the bench.* ClickHouse schema (../migrations/*.sql) — Oxagen's own
 * internal benchmark tracking database. INTERNAL ONLY: this never runs as
 * part of the product's `pnpm db:migrate` (that only touches
 * packages/telemetry/src/migrations/, the schema self-hosting customers get).
 * Reuses @oxagen/telemetry's ClickHouse client and statement splitter —
 * the only pieces of the product's migration machinery that apply here.
 *
 * There is no applied-migrations ledger, matching telemetry's own migrate.ts:
 * EVERY statement in EVERY *.sql replays on EVERY run. That puts the burden on
 * each migration to be idempotent (CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT
 * EXISTS). Nothing enforces it — a new migration that is not idempotent will
 * fail the second time this runs.
 *
 * Usage:
 *   pnpm --filter @oxagen/bench migrate
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRunEntry } from "@oxagen/telemetry";
import { closeClickhouse } from "@oxagen/telemetry";
import { splitStatements } from "@oxagen/telemetry/migrate";
import { chBenchCommand } from "@oxagen/telemetry/bench-client";

/** Sleep helper for the cold-start retry loop (mirrors telemetry's own migrate.ts). */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function applyWithRetry(stmt: string, attempts = 3): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await chBenchCommand(stmt);
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      // Every failure is retried, not just a cold start — a genuine SQL error
      // therefore costs two 15s waits before it surfaces. Worth it: a cold
      // start is the far more common failure here, and this script is not on
      // anyone's inner loop.
      process.stderr.write(
        JSON.stringify({
          level: "warn",
          msg: `bench migration statement failed (attempt ${attempt}/${attempts}) — usually a ClickHouse Cloud cold start; retrying`,
          err: err instanceof Error ? err.message : String(err),
        }) + "\n",
      );
      await delay(15_000);
    }
  }
}

export async function migrateBench(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(here, "..", "migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const body = readFileSync(join(migrationsDir, file), "utf8");
    for (const stmt of splitStatements(body)) {
      await applyWithRetry(stmt);
    }
  }
}

// Bundle-safe direct-run guard — see @oxagen/telemetry is-direct-run.ts.
if (isDirectRunEntry(import.meta.url, process.argv[1], "migrate")) {
  migrateBench()
    .then(() => closeClickhouse())
    .then(() => {
      process.stdout.write(
        JSON.stringify({
          level: "info",
          msg: "bench ClickHouse migration complete",
        }) + "\n",
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        JSON.stringify({
          level: "error",
          msg: "bench ClickHouse migration failed",
          err: String(err),
        }) + "\n",
      );
      process.exit(1);
    });
}
