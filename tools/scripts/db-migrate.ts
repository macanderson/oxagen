#!/usr/bin/env tsx
/**
 * Aggregate migrator: ClickHouse → Neo4j.
 *
 * Postgres is now managed by Atlas CLI (packages/database/atlas/migrations/).
 * This script handles the remaining stores — ClickHouse and Neo4j — which have
 * their own non-SQL migration idioms that Atlas doesn't cover.
 *
 * Developer workflow:
 *   pnpm db:migrate          — Atlas apply (Postgres) + this script (CH + Neo4j)
 *   pnpm db:migrate:pg       — Atlas apply Postgres only (local)
 *   pnpm db:migrate:diff     — Generate a new Atlas migration from schema diff
 *
 * CI: the migrate job runs `atlas migrate apply --env ci` for Postgres, then
 * this script with DB_MIGRATE_STORES=clickhouse,neo4j for the other stores.
 */
import kleur from "kleur";
import { formatError } from "./lib/format-error";
import { migrate as migrateClickhouse } from "@oxagen/telemetry/migrate";
import { closeClickhouse } from "@oxagen/telemetry";
import { migrate as migrateNeo4j } from "@oxagen/ontology/migrate";
import { closeDriver } from "@oxagen/ontology/client";

/**
 * Which stores to migrate, comma-separated in DB_MIGRATE_STORES.
 * Defaults to clickhouse,neo4j. Postgres is omitted — Atlas handles it.
 */
function selectedStores(): Set<string> {
  const raw = process.env.DB_MIGRATE_STORES ?? "clickhouse,neo4j";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function main(): Promise<void> {
  const stores = selectedStores();

  if (stores.has("clickhouse")) {
    console.log(kleur.bold("[migrate] clickhouse"));
    try {
      await migrateClickhouse();
    } finally {
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

  console.log(
    kleur.green().bold(`[migrate] complete (${[...stores].join(", ")})`),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(kleur.red(formatError(err)));
    process.exit(1);
  });
