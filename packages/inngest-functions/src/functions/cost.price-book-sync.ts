import {
  listRunsWithIncompleteCost,
  nextPriceBookBoundary,
  rebuildDailyTotals,
  rebuildRunTotals,
  syncPriceBookFromSources,
  utcDay,
} from "@oxagen/billing";
import { createFunction } from "../create-function";
import { logger } from "../logger";

/** Runs listed per query while draining, and the most one sync re-rolls. */
const REPRICE_BATCH = 500;
const REPRICE_CEILING = 10_000;

type WorkspaceDay = { orgId: string; workspaceId: string; day: string };

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
 * A sync that backdated rows also re-rolls the runs those rows can now
 * price. On a fresh installation runs seal before the first sync, and a sync
 * that ran with a catalog down leaves that catalog's models unpriced until
 * it recovers; `cost.run-rollup` has already written a completed
 * `run_totals` row with a blank or `estimated` cost, and the nightly sweep
 * skips it because its `rolled_up_at` is after its seal. Those costs stayed
 * wrong for ever. Both rebuilds are idempotent and replace what they find.
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
        models: result.models,
        counts: result.counts,
        failures: result.failures,
        held: result.held,
      };
    });

    // While the book is cold. Not "on a sync that wrote a row": the next
    // hourly sync of an unchanged book writes nothing, so tying the pass to
    // a write left every run beyond the first batch, and every run a
    // transient failure skipped, with its blank cost for good. Cold start
    // ends on its own (the window since the book's first row), and the
    // batches drain within it.
    let repriced = 0;
    let drained = false;
    if (report.coldStart) {
      const days = new Map<string, WorkspaceDay>();
      let seen = 0;
      for (let batch = 0; batch * REPRICE_BATCH < REPRICE_CEILING; batch += 1) {
        const pending = await step.run(`list-incomplete-runs-${batch}`, () =>
          listRunsWithIncompleteCost({
            limit: REPRICE_BATCH,
            offset: batch * REPRICE_BATCH,
          }),
        );
        if (pending.length === 0) {
          drained = true;
          break;
        }
        seen += pending.length;
        for (const runId of pending) {
          const day = await step.run(
            `run-${runId}`,
            async (): Promise<WorkspaceDay | null> => {
              try {
                const record = await rebuildRunTotals(runId);
                if (!record) return null;
                return {
                  orgId: record.orgId,
                  workspaceId: record.workspaceId,
                  day: utcDay(record.startedAt),
                };
              } catch (err) {
                // One run's degraded frame read must not stop the pass; the
                // run stays incomplete and the next hourly sync retries it.
                logger.warn(
                  { runId, err },
                  "cost.price-book-sync: run rollup failed",
                );
                return null;
              }
            },
          );
          if (day) {
            repriced += 1;
            days.set(`${day.workspaceId}:${day.day}`, day);
          }
        }
        if (pending.length < REPRICE_BATCH) {
          drained = true;
          break;
        }
      }
      for (const target of days.values()) {
        await step.run(`daily-${target.workspaceId}-${target.day}`, () =>
          rebuildDailyTotals(target),
        );
      }
      logger.info(
        { seen, repriced, drained, workspaceDays: days.size },
        drained
          ? "cost.price-book-sync: re-rolled every run the book can now price"
          : "cost.price-book-sync: re-rolled runs up to the per-sync ceiling; the next sync continues",
      );
    }

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
          models: report.models,
          counts: report.counts,
        },
        "cost.price-book-sync complete",
      );

    return { ...report, repriced, drained };
  },
);
