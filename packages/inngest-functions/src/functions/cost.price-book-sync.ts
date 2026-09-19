import {
  nextPriceBookBoundary,
  syncPriceBookFromSources,
} from "@oxagen/billing";
import { createFunction } from "../create-function";
import { logger } from "../logger";
import { PRICE_BOOK_BACKDATED_EVENT } from "./cost.price-book-reprice";

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
 *
 * A sync that finds backdated rows in force also asks for the runs those rows
 * can now price to be re-rolled. On a fresh installation runs seal before the first
 * sync, and a sync that ran with a catalog down leaves that catalog's models
 * unpriced until it recovers; `cost.run-rollup` has already written a
 * completed `run_totals` row with a blank or `estimated` cost, and the
 * nightly sweep skips it because its `rolled_up_at` is after its seal. Those
 * costs stayed wrong for ever. `cost.price-book-reprice` takes the event and
 * pages through every such run, so the work is not capped at what one
 * function run can hold.
 *
 * The request is keyed on the floored rows the book holds, not on what this
 * run wrote. A manual `--apply` can commit floored rows and fail to dispatch
 * the event; keyed on `written` this sync then read a correct book, wrote
 * nothing, and asked for nothing, so nobody ever asked again. Keyed on the
 * book, every sync inside the cold window re-asks until the window closes.
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
      // The next hour boundary, not `new Date()`: that instant is read before
      // the catalogs and the transaction, so frames rolled up in between were
      // priced against a row this sync then closed behind them.
      const result = await syncPriceBookFromSources({
        effectiveFrom: nextPriceBookBoundary(new Date()),
      });
      return {
        written: result.written,
        unchanged: result.unchanged,
        renamed: result.renamed,
        deferred: result.deferred,
        superseded: result.superseded,
        retired: result.retired,
        coldStart: result.coldStart,
        hasBackdatedRows: result.hasBackdatedRows,
        models: result.models,
        counts: result.counts,
        failures: result.failures,
        held: result.held,
      };
    });

    // Only while backdated rows are in force: a row effective from the next
    // boundary prices nothing that has already run, so there is nothing to
    // re-roll.
    //
    // The test is the book's floored rows, not this run's write count. A
    // write count loses the request the moment a dispatch fails or a manual
    // apply commits the rows without asking: the next sync reads a correct
    // book, writes nothing, and would ask for nothing, so runs the floored
    // rows can now price stay blank for ever. Reading the obligation off the
    // book instead means every sync inside the cold window re-asks until the
    // window closes. That costs one event an hour for at most
    // COLD_START_WINDOW_MS, and the reprice chain is a keyset pass over runs
    // whose cost is still blank or estimated — empty once they are priced —
    // against a repricing that is otherwise never requested again.
    const repriceRequested = report.coldStart && report.hasBackdatedRows;
    if (repriceRequested)
      await step.sendEvent("request-reprice", {
        name: PRICE_BOOK_BACKDATED_EVENT,
        data: {},
      });

    if (report.failures.length > 0)
      logger.warn(
        {
          written: report.written,
          unchanged: report.unchanged,
          renamed: report.renamed,
          deferred: report.deferred,
          superseded: report.superseded,
          retired: report.retired,
          coldStart: report.coldStart,
          hasBackdatedRows: report.hasBackdatedRows,
          models: report.models,
          counts: report.counts,
          failures: report.failures,
          held: report.held,
        },
        "cost.price-book-sync completed with catalog failures — models only those catalogs price may be unpriced; catalogs below a failed one were held so a lower-priority price could not supersede rows the failed catalog still has in force",
      );
    else
      logger.info(
        {
          written: report.written,
          unchanged: report.unchanged,
          renamed: report.renamed,
          deferred: report.deferred,
          superseded: report.superseded,
          retired: report.retired,
          coldStart: report.coldStart,
          hasBackdatedRows: report.hasBackdatedRows,
          repriceRequested,
          models: report.models,
          counts: report.counts,
        },
        "cost.price-book-sync complete",
      );

    return { ...report, repriceRequested };
  },
);
