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
 * `--effective-from` the run is effective from the instant it runs, so a
 * later run closes the previous rows at the new instant and every cost record
 * keeps the entry it was priced with. (The default used to be the top of the
 * UTC hour so a re-run within the hour corrected a row in place — but a row
 * whose instant has passed may already have priced runs, and `syncPriceBook`
 * now refuses to rewrite one; a same-instant re-run with unchanged terms is
 * still a no-op.) A run that would start earlier than an open row is refused
 * for the same reason: a correction is always a later row. Negotiated and
 * override rows are never touched.
 *
 * Runs against whatever DATABASE_URL is in scope and prints the host so the
 * target is always visible (CLAUDE.md: echo the target DB before a mutation).
 */
import kleur from "kleur";
import {
  nextPriceBookBoundary,
  syncPriceBookFromSources,
  type PriceEntrySeed,
} from "@oxagen/billing";
import { closeDatabase } from "@oxagen/database";

export interface Flags {
  apply: boolean;
  offline: boolean;
  effectiveFrom: Date;
}

export function parseFlags(argv: string[], now: Date): Flags {
  // The next hour boundary, the same instant the hourly job uses. `now` is
  // read before the catalogs and the transaction, so a frame rolled up in
  // between is priced against a row this run then closes behind it. An
  // operator who names an instant with --effective-from gets exactly that.
  const flags: Flags = {
    apply: false,
    offline: false,
    effectiveFrom: nextPriceBookBoundary(now),
  };
  for (const arg of argv) {
    if (arg === "--apply") flags.apply = true;
    else if (arg === "--offline") flags.offline = true;
    else if (arg.startsWith("--effective-from=")) {
      const at = new Date(arg.slice("--effective-from=".length));
      if (Number.isNaN(at.getTime()))
        throw new Error(`--effective-from must be an RFC 3339 instant: ${arg}`);
      // Never the past. A list row that starts at an instant already gone
      // reprices every frame settled since then on its next rollup, or makes
      // it unpriced, and `syncPriceBook` cannot catch it for a key with no
      // open row (one newly seen, or retired). Backdating is the cold-start
      // path's job alone, and it does it under its own rules.
      if (at.getTime() < now.getTime())
        throw new Error(
          `--effective-from must not be in the past (${at.toISOString()} is before ${now.toISOString()}): a list price that starts in the past reprices runs already settled`,
        );
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
  for (const source of report.held)
    console.log(
      kleur.yellow(
        `  ! ${source} answered but was held: a catalog above it failed, and its prices must not supersede rows that catalog still has in force`,
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
      `  ${report.written} rows written, ${report.renamed} renamed, ${report.superseded} superseded, ${report.retired} retired, ${report.unchanged} unchanged, ${report.deferred} deferred to a scheduled correction.\n`,
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
