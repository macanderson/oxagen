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
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import kleur from "kleur";
import { loadEnv } from "@oxagen/config/env";
import { seedPlatform } from "@oxagen/database/seed";
import { closeDatabase } from "@oxagen/database/client";
import { migrate as migrateClickhouse } from "@oxagen/telemetry/migrate";
import { closeClickhouse } from "@oxagen/telemetry";
import { migrate as migrateNeo4j } from "@oxagen/ontology/migrate";
import { closeDriver } from "@oxagen/ontology/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const ROOT = resolve(__dirname, "..", "..");
const PG_MIGRATIONS_DIR = join(ROOT, "packages/database/drizzle");

/** SHA-256 of a migration file body, used to detect post-apply edits. */
function checksumOf(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * The baseline is the `0000_*` ordinal — a regenerated full-schema pg_dump
 * snapshot rather than an incremental migration. It is exempt from the
 * edit-immutability guard (its checksum is re-stamped, never re-run); every
 * incremental migration (0001+) remains strictly immutable.
 */
function isBaselineSnapshot(filename: string): boolean {
  return filename.startsWith("0000_");
}

async function migratePostgres(): Promise<void> {
  const env = loadEnv();
  const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false });
  try {
    await sql/* sql */`
      CREATE TABLE IF NOT EXISTS public._migrations (
        filename text primary key,
        checksum text,
        applied_at timestamptz not null default now()
      )
    `;
    // Pre-checksum DBs have the table without this column; add it idempotently.
    await sql.unsafe(`ALTER TABLE public._migrations ADD COLUMN IF NOT EXISTS checksum text`);

    const applied = await sql<{ filename: string; checksum: string | null }[]>/* sql */`
      SELECT filename, checksum FROM public._migrations
    `;
    const appliedChecksums = new Map(applied.map((r) => [r.filename, r.checksum]));

    const files = readdirSync(PG_MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const body = readFileSync(join(PG_MIGRATIONS_DIR, file), "utf8");
      const checksum = checksumOf(body);

      if (appliedChecksums.has(file)) {
        const stored = appliedChecksums.get(file);
        if (stored == null) {
          // Legacy row applied before checksums existed — backfill, don't re-run.
          await sql/* sql */`
            UPDATE public._migrations SET checksum = ${checksum} WHERE filename = ${file}
          `;
          console.log(kleur.gray(`[pg] skip ${file} (already applied; backfilled checksum)`));
        } else if (stored !== checksum) {
          if (isBaselineSnapshot(file)) {
            // The baseline (0000_*) is NOT an incremental migration — it is a
            // regenerated full-schema pg_dump snapshot, re-baselined as the
            // schema evolves (see `db: re-baseline migrations`). Its body (and
            // thus checksum) changes when regenerated even though databases that
            // already have it applied are unaffected: the snapshot is never
            // re-run once applied, and the only edits it receives are idempotent
            // (`CREATE SCHEMA IF NOT EXISTS`, stripped pg_dump meta-commands).
            // Re-stamp the stored checksum to the canonical snapshot rather than
            // failing — the immutability guard below still applies to every
            // incremental migration (0001+).
            await sql/* sql */`
              UPDATE public._migrations SET checksum = ${checksum} WHERE filename = ${file}
            `;
            console.log(
              kleur.yellow(
                `[pg] re-stamped baseline ${file} (regenerated snapshot; ` +
                  `${stored.slice(0, 12)}… → ${checksum.slice(0, 12)}…; schema unchanged, not re-run)`,
              ),
            );
          } else {
            // A shipped migration was edited after it was applied. This is the one
            // thing the immutability rule (engineering policy §5) forbids: edits
            // never re-run, so the DB and the file silently diverge. Fail loudly.
            throw new Error(
              `[pg] checksum mismatch for ${file}: the file was edited after it was ` +
                `applied (stored ${stored.slice(0, 12)}…, now ${checksum.slice(0, 12)}…). ` +
                `Shipped migrations are immutable — revert the edit and add a NEW migration instead.`,
            );
          }
        } else {
          console.log(kleur.gray(`[pg] skip ${file} (already applied)`));
        }
        continue;
      }

      console.log(kleur.cyan(`[pg] applying ${file}`));
      // Reset search_path before every file. 0000_baseline.sql is a pg_dump that
      // runs `set_config('search_path', '', false)`, which persists on this shared
      // single connection (max:1) and would otherwise make later migrations that
      // reference unqualified types (e.g. `citext`) fail with "type does not exist".
      await sql.unsafe(`SET search_path TO public`);
      await sql.unsafe(body);
      await sql/* sql */`
        INSERT INTO public._migrations (filename, checksum) VALUES (${file}, ${checksum})
      `;
    }
    console.log(kleur.green("[pg] migrations complete"));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Which stores to migrate, as a comma-separated list in `DB_MIGRATE_STORES`.
 * Defaults to all three (local dev / `pnpm db:reset` run every store). CI for a
 * managed environment sets `DB_MIGRATE_STORES=postgres,clickhouse` because the
 * prod/preview Neo4j credentials are not provisioned in CI yet — selecting a
 * subset keeps the runner from dialing a store it has no creds for.
 */
function selectedStores(): Set<string> {
  const raw = process.env.DB_MIGRATE_STORES ?? "postgres,clickhouse,neo4j";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function main(): Promise<void> {
  const stores = selectedStores();

  if (stores.has("postgres")) {
    console.log(kleur.bold("[migrate] postgres"));
    await migratePostgres();
    // Platform-global seed (Free plan, etc.) — idempotent, baked into the migrate
    // path so a fresh DB / `pnpm db:reset` always re-seeds it. NOT the dev org.
    console.log(kleur.bold("[migrate] seed (platform defaults)"));
    try {
      await seedPlatform();
      console.log(kleur.green("[seed] platform defaults applied"));
    } finally {
      await closeDatabase();
    }
  }

  if (stores.has("clickhouse")) {
    console.log(kleur.bold("[migrate] clickhouse"));
    try {
      await migrateClickhouse();
    } finally {
      // The CH client holds a keepalive HTTP socket that prevents process
      // exit; close it here since the imported migrate() doesn't.
      await closeClickhouse();
    }
  }

  if (stores.has("neo4j")) {
    console.log(kleur.bold("[migrate] neo4j"));
    try {
      await migrateNeo4j();
    } finally {
      await closeDriver();
    }
  }

  console.log(kleur.green().bold(`[migrate] complete (${[...stores].join(", ")})`));
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(kleur.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
