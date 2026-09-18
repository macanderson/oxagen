/**
 * price-book-sync.ts — keeping the list price book filled, without anyone
 * remembering to fill it.
 *
 * `cost.price_entries` ships empty. Until this ran on a schedule the only
 * thing that ever wrote a list row was `pnpm billing:price-book-sync --apply`,
 * a manual script that is dry-run by default and is wired into no migration
 * and no deploy — so an installation that nobody ran it against priced
 * nothing, and every run's `cost.run_totals.cost_micros` came back NULL. That
 * is not a rounding error in a cost report; it is the cost report being blank.
 *
 * {@link syncPriceBookFromSources} is what the `cost.price-book-sync` job
 * calls. It merges the operator's overrides, the in-code card and the
 * published catalogs (./price-sources.ts, ./price-overrides.ts) and writes the
 * result through {@link syncPriceBook}, which is idempotent on the row key, so
 * running it hourly costs nothing and running it on a cold database fills the
 * book.
 *
 * The catalogs are best-effort and the card is not: a sync whose network reads
 * all failed still writes every model the card names, which is why the book
 * can never end up empty because a third party had an outage.
 */
import {
  fetchPublishedPrices,
  inCodeCardPrices,
  mergePublishedPrices,
  seedsFromPublishedPrices,
  type FetchLike,
  type PriceSourceId,
  type PriceSourceResult,
  type PublishedModelPrice,
} from "./price-sources";
import { loadPriceOverrides } from "./price-overrides";
import {
  priceEntriesFromRateCards,
  syncPriceBook,
  type PriceEntrySeed,
} from "./price-book";
import { IMAGE_RATE_CARD, VIDEO_RATE_CARD } from "./pricing";

export interface PriceBookSyncReport {
  /** Rows inserted or corrected in place. */
  written: number;
  /** Rows whose price and names were already what the sources say. */
  unchanged: number;
  /**
   * Open rows whose aliases a catalog moved while leaving the rate alone.
   * Updated in place — a rename is not a repricing (see {@link syncPriceBook}).
   */
  renamed: number;
  /** Keys left alone because an operator scheduled a later correction. */
  deferred: number;
  /**
   * Open rows closed because this sync re-priced the same model and class
   * under a different provider name (see {@link syncPriceBook}).
   */
  superseded: number;
  /**
   * Open rows closed because a complete refresh no longer emitted them — a
   * model a catalog withdrew, or a class it stopped publishing. Zero whenever
   * a catalog failed or the run was offline: an absence the sync cannot tell
   * from an outage retires nothing (see {@link syncPriceBook}).
   */
  retired: number;
  /** The book held no list row before this run; see `syncPriceBook`. */
  coldStart: boolean;
  /** Distinct models the book now prices. */
  models: number;
  /** How many models each source ended up being the authority for. */
  counts: Record<PriceSourceId, number>;
  /** Every catalog read that contributed nothing, and why. */
  failures: { source: PriceSourceId; error: string }[];
  /**
   * Catalogs that answered but were not merged because a catalog above them
   * in precedence failed: merging them would let a lower-priority price
   * supersede rows the failed source still has in force.
   */
  held: PriceSourceId[];
  /**
   * The rows the merge produced — what was written, or on a dry run what
   * would have been. Carried so an operator can see the price book before
   * agreeing to it; the scheduled job never logs it.
   */
  seeds: PriceEntrySeed[];
}

export interface SyncPriceBookFromSourcesArgs {
  /** The instant the written prices take effect. A later run supersedes an earlier one. */
  effectiveFrom: Date;
  /** Injected for tests; the global fetch in production. */
  fetchImpl?: FetchLike;
  /** Injected for tests; the environment's own values in production. */
  overrides?: {
    filePath?: string;
    inline?: string;
    readFile?: (path: string) => string;
  };
  /** Skip the network entirely — the card and the operator's overrides alone. */
  offline?: boolean;
  /** Write nothing; report what would have been written. */
  dryRun?: boolean;
  write?: (args: {
    effectiveFrom: Date;
    seeds: readonly PriceEntrySeed[];
    retireAbsent: boolean;
    completedCatalogs: readonly PriceSourceId[];
  }) => Promise<{
    written: number;
    unchanged: number;
    renamed?: number;
    deferred?: number;
    superseded?: number;
    retired?: number;
    coldStart?: boolean;
  }>;
}

/**
 * Merge every price source and write the list book. Returns what changed and
 * which catalogs failed, so the job can log a sync that half-worked as such
 * rather than as a success.
 */
export async function syncPriceBookFromSources(
  args: SyncPriceBookFromSourcesArgs,
): Promise<PriceBookSyncReport> {
  const overrides = loadPriceOverrides(args.overrides ?? {});

  const catalogs: PriceSourceResult[] = args.offline
    ? []
    : await fetchPublishedPrices({ fetchImpl: args.fetchImpl });

  // Precedence, highest first: what the operator typed, then the card Oxagen
  // reconciles against invoices, then whatever the catalogs know about every
  // other model. OpenRouter before models.dev: it is the one that actually
  // serves the call and publishes cache-read and cache-write rates per model.
  //
  // The chain stops at the first catalog that failed. A catalog below a
  // failed one is HELD, not merged: with OpenRouter down and models.dev up,
  // every model OpenRouter owned would otherwise be absent from its group
  // and fall to models.dev's price — written as a new row from this run's
  // instant, which the resolver then prefers over the still-valid OpenRouter
  // row (the two catalogs commonly spell one model as canonical and alias
  // inverses, so the new row matches). Runs during the outage would be priced
  // at the lower catalog's rate and switch back when OpenRouter recovered. A
  // failed source keeps its existing rows in force instead, and the sources
  // above it still write; the ones below wait for the next run.
  const ordered: PublishedModelPrice[][] = [overrides, inCodeCardPrices()];
  const held: PriceSourceId[] = [];
  let chainBroken = false;
  for (const id of ["openrouter", "models_dev"] as const) {
    const hit = catalogs.find((c) => c.source === id);
    if (!hit) continue;
    if (hit.error !== null) {
      chainBroken = true;
      continue;
    }
    if (chainBroken) {
      held.push(id);
      continue;
    }
    ordered.push(hit.prices);
  }

  const merged = mergePublishedPrices(ordered);
  const seeds: PriceEntrySeed[] = [
    ...seedsFromPublishedPrices(merged.prices, args.effectiveFrom),
    // Media prices have no published catalog to read and no token classes;
    // they come from the in-code card alone, as they always have.
    ...priceEntriesFromRateCards(args.effectiveFrom, {
      tokens: {},
      images: IMAGE_RATE_CARD,
      videos: VIDEO_RATE_CARD,
    }).map((s) => ({ ...s, catalog: "in_code_card" as const })),
  ];

  const failures = catalogs
    .filter((c): c is PriceSourceResult & { error: string } => c.error !== null)
    .map((c) => ({ source: c.source, error: c.error }));

  // Retirement is decided per catalog. A row absent from the seeds is a
  // price that ended only if the catalog that published it answered
  // completely this run; a row from a catalog that failed, or was held
  // behind a failed one, is absent because nobody asked, and closing it
  // would leave its models unpriced until the catalog came back. Deciding
  // this book-wide (retire only when EVERY catalog answered) let a model
  // OpenRouter withdrew stay priced for as long as models.dev was down.
  //
  // `retireAbsent` is the book-wide statement, kept for rows written before
  // the catalog column existed: those retire only when every source
  // answered, as before. An offline run asked no catalog at all.
  const retireAbsent = args.offline !== true && failures.length === 0;
  // The overrides and the in-code card are read from this process and never
  // fail, so they always complete, even offline. A published catalog
  // completes when it answered and was not held behind a failed one.
  const completedCatalogs: PriceSourceId[] = [
    "operator_override",
    "in_code_card",
    ...catalogs
      .filter((c) => c.error === null && !held.includes(c.source))
      .map((c) => c.source),
  ];

  if (args.dryRun === true)
    return {
      written: 0,
      unchanged: 0,
      renamed: 0,
      deferred: 0,
      superseded: 0,
      retired: 0,
      coldStart: false,
      models: merged.prices.length,
      counts: merged.counts,
      failures,
      held,
      seeds,
    };

  const write =
    args.write ??
    ((a: {
      effectiveFrom: Date;
      seeds: readonly PriceEntrySeed[];
      retireAbsent: boolean;
      completedCatalogs: readonly PriceSourceId[];
    }) =>
      syncPriceBook({
        effectiveFrom: a.effectiveFrom,
        seeds: a.seeds,
        retireAbsent: a.retireAbsent,
        completedCatalogs: a.completedCatalogs,
      }));
  const result = await write({
    effectiveFrom: args.effectiveFrom,
    seeds,
    retireAbsent,
    completedCatalogs,
  });

  return {
    written: result.written,
    unchanged: result.unchanged,
    renamed: result.renamed ?? 0,
    deferred: result.deferred ?? 0,
    superseded: result.superseded ?? 0,
    retired: result.retired ?? 0,
    coldStart: result.coldStart ?? false,
    models: merged.prices.length,
    counts: merged.counts,
    failures,
    held,
    seeds,
  };
}
