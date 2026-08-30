#!/usr/bin/env tsx
/**
 * Platform seed: inserts the Free/Build/Scale/Enterprise billing plans.
 * Idempotent (onConflictDoNothing). Called after `atlas migrate apply` on
 * every fresh database — local, preview, and production.
 *
 * Run via `pnpm db:seed-platform`.
 */
import kleur from "kleur";
import { seedPlatform } from "@oxagen/database/seed";
import { closeDatabase } from "@oxagen/database/client";
import { formatError } from "./lib/format-error";

async function main(): Promise<void> {
  await seedPlatform();
  console.log(kleur.green("[seed] platform defaults applied"));
}

// closeDatabase() is awaited BEFORE process.exit — a `.finally()` after a
// `.then(() => process.exit(0))` never runs, because exit is immediate.
main()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error(kleur.red(formatError(err)));
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
