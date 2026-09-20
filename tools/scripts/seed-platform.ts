#!/usr/bin/env tsx
/**
 * Idempotent platform defaults: the Free plan and book editions.
 * Runs after local migrations and as a bundled production migration step.
 * Paid plan identifiers remain managed by billing:stripe-sync.
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
