import { syncPriceBookFromSources } from "@oxagen/billing";
import { createFunction } from "../create-function";
import { logger } from "../logger";

/**
 * `cost.price-book-sync` — keep `cost.price_entries` filled, hourly, without
 * anyone remembering to fill it.
 *
 * The price book ships empty. Until this existed, the only thing that ever
 * wrote a list row was `pnpm billing:price-book-sync --apply` — a manual
 * script, dry-run by default, wired into no migration and no deploy. An
 * installation nobody had run it against priced nothing: `priceFrame` found
 * no entry for any token class, `cost.run_totals.cost_micros` came back NULL
 * for every run, and the Runs table's Cost column read "not recorded". That
 * is not a mispriced report, it is a blank one, and it is worst for wrapped
 * agents, whose client-attested frames usually carry no cost figure of their
 * own to fall back on.
 *
 * So the book fills itself. `syncPriceBookFromSources` merges the operator's
 * environment overrides, Oxagen's in-code rate card and the published
 * catalogs, and writes the result; `syncPriceBook` underneath is idempotent
 * on the row key, so an hourly run of an unchanged book writes nothing and a
 * run against a cold database fills it. A price that has genuinely changed
 * becomes a new row effective from this run's instant, and the old row closes
 * at the same instant — so a run that was priced yesterday keeps naming the
 * entry it was actually priced with.
 *
 * Hourly rather than daily because the cost of a no-op run is one query and
 * two HTTP GETs, while the cost of a stale book is every run in the window
 * priced wrong or not at all.
 *
 * The catalog reads are best-effort: a catalog that is down contributes
 * nothing and is reported, and the in-code card alone still seeds a usable
 * book. A sync that wrote rows with a catalog down is a partial success and
 * is logged as one — never as a clean success, because "prices synced" while
 * half the catalog was missing is exactly the line that stops anyone looking.
 *
 * The concurrency limit is 1 across the whole function: two syncs in flight
 * would race the same rows with two different `effectiveFrom` instants, and
 * the loser would leave two rows open for one key.
 */
export const [costPriceBookSync] = createFunction(
  {
    id: "cost.price-book-sync",
    retries: 3,
    concurrency: { limit: 1 },
  },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const report = await step.run("sync", async () => {
      const result = await syncPriceBookFromSources({
        effectiveFrom: new Date(),
      });
      return {
        written: result.written,
        unchanged: result.unchanged,
        models: result.models,
        counts: result.counts,
        failures: result.failures,
      };
    });

    if (report.failures.length > 0)
      logger.warn(
        {
          written: report.written,
          unchanged: report.unchanged,
          models: report.models,
          counts: report.counts,
          failures: report.failures,
        },
        "cost.price-book-sync completed with catalog failures — models only those catalogs price may be unpriced",
      );
    else
      logger.info(
        {
          written: report.written,
          unchanged: report.unchanged,
          models: report.models,
          counts: report.counts,
        },
        "cost.price-book-sync complete",
      );

    return report;
  },
);
