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
  /** Rows whose price was already what the sources say. */
  unchanged: number;
  /** Distinct models the book now prices. */
  models: number;
  /** How many models each source ended up being the authority for. */
  counts: Record<PriceSourceId, number>;
  /** Every catalog read that contributed nothing, and why. */
  failures: { source: PriceSourceId; error: string }[];
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
  }) => Promise<{ written: number; unchanged: number }>;
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
  const ordered: PublishedModelPrice[][] = [overrides, inCodeCardPrices()];
  for (const id of ["openrouter", "models_dev"] as const) {
    const hit = catalogs.find((c) => c.source === id);
    if (hit) ordered.push(hit.prices);
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
    }),
  ];

  const failures = catalogs
    .filter((c): c is PriceSourceResult & { error: string } => c.error !== null)
    .map((c) => ({ source: c.source, error: c.error }));

  if (args.dryRun === true)
    return {
      written: 0,
      unchanged: 0,
      models: merged.prices.length,
      counts: merged.counts,
      failures,
      seeds,
    };

  const write =
    args.write ??
    ((a: { effectiveFrom: Date; seeds: readonly PriceEntrySeed[] }) =>
      syncPriceBook({ effectiveFrom: a.effectiveFrom, seeds: a.seeds }));
  const result = await write({ effectiveFrom: args.effectiveFrom, seeds });

  return {
    written: result.written,
    unchanged: result.unchanged,
    models: merged.prices.length,
    counts: merged.counts,
    failures,
    seeds,
  };
}
