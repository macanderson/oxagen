#!/usr/bin/env tsx
/**
 * Aggregate migrator: Postgres → ClickHouse → Neo4j.
 *
 * Replaces `drizzle-kit migrate` for the foundations + agent-runtime
 * milestones. The Drizzle SQL files in `packages/database/drizzle/` are
 * hand-written and aren't tracked in a drizzle-kit journal, so we apply
 * them ourselves and track applied filenames in `public._migrations`.
 *
 * Run via `pnpm db:migrate`, which invokes
 *   tsx --env-file=.env.local tools/scripts/db-migrate.ts
 * so env validation in @oxagen/config has values to validate (sourced from
 * Vercel via `vercel env pull`, refreshed by `pnpm env:pull`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import kleur from "kleur";
import { loadEnv } from "@oxagen/config/env";
import { migrate as migrateClickhouse } from "@oxagen/telemetry/migrate";
import { closeClickhouse } from "@oxagen/telemetry";
import { migrate as migrateNeo4j } from "@oxagen/ontology/migrate";
import { closeDriver } from "@oxagen/ontology/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const ROOT = resolve(__dirname, "..", "..");
const PG_MIGRATIONS_DIR = join(ROOT, "packages/database/drizzle");

async function migratePostgres(): Promise<void> {
  const env = loadEnv();
  const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false });
  try {
    await sql/* sql */`
      CREATE TABLE IF NOT EXISTS public._migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      )
    `;
    const applied = await sql<{ filename: string }[]>/* sql */`
      SELECT filename FROM public._migrations
    `;
    const appliedSet = new Set(applied.map((r) => r.filename));

    const files = readdirSync(PG_MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(kleur.gray(`[pg] skip ${file} (already applied)`));
        continue;
      }
      const body = readFileSync(join(PG_MIGRATIONS_DIR, file), "utf8");
      console.log(kleur.cyan(`[pg] applying ${file}`));
      await sql.unsafe(body);
      await sql/* sql */`
        INSERT INTO public._migrations (filename) VALUES (${file})
      `;
    }
    console.log(kleur.green("[pg] migrations complete"));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  console.log(kleur.bold("[migrate] postgres"));
  await migratePostgres();
  console.log(kleur.bold("[migrate] clickhouse"));
  try {
    await migrateClickhouse();
  } finally {
    // The CH client holds a keepalive HTTP socket that prevents process
    // exit; close it here since the imported migrate() doesn't.
    await closeClickhouse();
  }
  console.log(kleur.bold("[migrate] neo4j"));
  try {
    await migrateNeo4j();
  } finally {
    await closeDriver();
  }
  console.log(kleur.green().bold("[migrate] all stores complete"));
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(kleur.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
