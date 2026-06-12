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

async function main(): Promise<void> {
  await seedPlatform();
  console.log(kleur.green("[seed] platform defaults applied"));
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(kleur.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  })
  .finally(() => closeDatabase());
