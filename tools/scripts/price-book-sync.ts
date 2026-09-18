#!/usr/bin/env tsx
/**
 * price-book-sync — write the list price book (`cost.price_entries`,
 * org_id NULL, source 'list') from every price source (ADR-060 §1): the
 * operator's environment overrides, the in-code rate cards in
 * `packages/billing/src/pricing.ts`, and the published catalogs.
 *
 *   pnpm billing:price-book-sync                         # report + DRY-RUN
 *   pnpm billing:price-book-sync --apply                 # write the rows
 *   pnpm billing:price-book-sync --offline               # skip the catalogs
 *   pnpm billing:price-book-sync --effective-from=<RFC 3339>
 *
 * **Nothing depends on anyone running this.** The `cost.price-book-sync` job
 * runs the same merge hourly, which is what keeps a fresh installation from
 * pricing nothing at all. This remains for a targeted correction, for
 * checking what the merge would write before it writes it, and for an
 * air-gapped installation where the catalogs are unreachable (`--offline`).
 *
 * A price is effective over [effective_from, effective_to). With no
 * `--effective-from` the run is effective from the top of the current UTC
 * hour, so a re-run within the hour corrects a row in place and a later run
 * closes the previous rows at the new instant. A run that would start earlier
 * than an open row is refused by `syncPriceBook`: a correction is always a
 * later row, so every cost record keeps the entry it was priced with.
 * Negotiated and override rows are never touched.
 *
 * Runs against whatever DATABASE_URL is in scope and prints the host so the
 * target is always visible (CLAUDE.md: echo the target DB before a mutation).
 */
import kleur from "kleur";
import { syncPriceBookFromSources, type PriceEntrySeed } from "@oxagen/billing";
import { closeDatabase } from "@oxagen/database";

export interface Flags {
  apply: boolean;
  offline: boolean;
  effectiveFrom: Date;
}

/** The top of the UTC hour `now` falls in. */
export function topOfHour(now: Date): Date {
  const at = new Date(now.getTime());
  at.setUTCMinutes(0, 0, 0);
  return at;
}

export function parseFlags(argv: string[], now: Date): Flags {
  const flags: Flags = {
    apply: false,
    offline: false,
    effectiveFrom: topOfHour(now),
  };
  for (const arg of argv) {
    if (arg === "--apply") flags.apply = true;
    else if (arg === "--offline") flags.offline = true;
    else if (arg.startsWith("--effective-from=")) {
      const at = new Date(arg.slice("--effective-from=".length));
      if (Number.isNaN(at.getTime()))
        throw new Error(`--effective-from must be an RFC 3339 instant: ${arg}`);
      flags.effectiveFrom = at;
    } else throw new Error(`unknown flag: ${arg}`);
  }
  return flags;
}

/** One line per seed row: what the sync will write. */
export function reportLines(seeds: readonly PriceEntrySeed[]): string[] {
  return seeds.map(
    (s) =>
      `${s.provider.padEnd(12)} ${s.model.padEnd(40)} ${s.tokenClass.padEnd(16)} ${s.microsPerMillion.toString().padStart(14)} micros/1M ${s.unit}`,
  );
}

/** The database host a DATABASE_URL points at, with no credentials. */
export function describeTarget(databaseUrl: string | undefined): string {
  if (!databaseUrl) return "(DATABASE_URL unset)";
  try {
    const url = new URL(databaseUrl);
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return "(DATABASE_URL unparseable)";
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2), new Date());

  console.log(kleur.bold().cyan("\n══ Price book ══\n"));
  console.log(
    `  Target database: ${describeTarget(process.env["DATABASE_URL"])}`,
  );
  console.log(`  Effective from:  ${flags.effectiveFrom.toISOString()}`);
  console.log(
    `  Catalogs:        ${flags.offline ? "skipped (--offline)" : "OpenRouter, models.dev"}\n`,
  );

  const report = await syncPriceBookFromSources({
    effectiveFrom: flags.effectiveFrom,
    offline: flags.offline,
    dryRun: !flags.apply,
  });

  for (const [source, count] of Object.entries(report.counts))
    if (count > 0) console.log(`  ${source.padEnd(18)} ${count} models`);
  console.log(`\n  ${report.models} models priced in total.`);

  for (const failure of report.failures)
    console.log(
      kleur.yellow(
        `  ! ${failure.source} contributed nothing: ${failure.error}`,
      ),
    );

  if (!flags.apply) {
    console.log(kleur.dim("\n  Rows this would write:\n"));
    for (const line of reportLines(report.seeds)) console.log(`  ${line}`);
    console.log(
      kleur.dim(
        `\n  ${report.seeds.length} rows (dry-run — pass --apply to write.)\n`,
      ),
    );
    return;
  }

  console.log(
    kleur.bold().cyan("\n══ Done ══\n") +
      `  ${report.written} rows written, ${report.unchanged} unchanged.\n`,
  );
}

// Run only when invoked directly, so a test can import the pure helpers
// without the module writing the price book as a side effect.
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  main()
    .then(() => closeDatabase())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error(kleur.red("price-book-sync failed:"), err);
      await closeDatabase();
      process.exit(1);
    });
}
