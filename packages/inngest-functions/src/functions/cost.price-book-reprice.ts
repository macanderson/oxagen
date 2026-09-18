import {
  type IncompleteCostRun,
  listRunsWithIncompleteCost,
  rebuildDailyTotals,
  rebuildRunTotals,
  utcDay,
} from "@oxagen/billing";
import { NonRetriableError } from "@oxagen/functions";
import { createFunction } from "../create-function";
import { logger } from "../logger";

/** The event `cost.price-book-sync` sends after a backdated write, and this function sends itself per page. */
export const PRICE_BOOK_BACKDATED_EVENT = "cost/price-book.backdated";

/**
 * Runs re-rolled per invocation. Each run is one step and each workspace-day
 * it touched is one more, so a page costs at most twice this plus two, under
 * Inngest's 1,000 steps per function run.
 */
const REPRICE_PAGE = 250;

type WorkspaceDay = { orgId: string; workspaceId: string; day: string };

function readCursor(data: unknown): IncompleteCostRun | undefined {
  const after = (data as { after?: unknown } | null)?.after;
  if (after === undefined || after === null) return undefined;
  const { runId, startedAt } = after as Partial<IncompleteCostRun>;
  if (
    typeof runId !== "string" ||
    runId.length === 0 ||
    typeof startedAt !== "string" ||
    Number.isNaN(Date.parse(startedAt))
  )
    throw new NonRetriableError(
      `${PRICE_BOOK_BACKDATED_EVENT} carries a malformed cursor`,
    );
  return { runId, startedAt };
}

/**
 * `cost/price-book.backdated` → re-roll every run whose cost is blank or
 * `estimated`, one page per invocation, until the list is empty.
 *
 * The sync used to re-roll the first 500 such runs inline and stop. The next
 * hourly sync of an unchanged book writes nothing and is not backdated, so it
 * never re-rolled again, and an installation with more than 500 incomplete
 * runs kept the rest blank.
 *
 * Each invocation reads one page after the event's cursor, rebuilds those
 * runs and the workspace-days they started on, and sends itself the next
 * cursor when the page was full. The cursor matters: a run whose model no
 * source prices is still incomplete after its rebuild, so reading the head
 * of the list again would return the same page.
 *
 * A rebuild that throws is retried as a step, with Inngest's backoff, up to
 * `retries` times. A run that still fails is logged and skipped so that one
 * run cannot stop the chain; the next backdated sync reads it again.
 *
 * The concurrency limit is 1: two chains can start an hour apart when two
 * syncs in a row backdate rows. Both rebuilds replace what they find, so an
 * overlap is wasted work, not wrong work.
 */
export const [costPriceBookReprice] = createFunction(
  {
    id: "cost.price-book-reprice",
    retries: 3,
    concurrency: { limit: 1 },
  },
  { event: PRICE_BOOK_BACKDATED_EVENT },
  async ({ event, step }) => {
    const after = readCursor(event.data);
    const page = await step.run("list-incomplete-runs", () =>
      listRunsWithIncompleteCost({ limit: REPRICE_PAGE, after }),
    );

    let repriced = 0;
    let failed = 0;
    const days = new Map<string, WorkspaceDay>();
    for (const { runId } of page) {
      let day: WorkspaceDay | null;
      try {
        day = await step.run(
          `run-${runId}`,
          async (): Promise<WorkspaceDay | null> => {
            const record = await rebuildRunTotals(runId);
            if (!record) return null;
            return {
              orgId: record.orgId,
              workspaceId: record.workspaceId,
              day: utcDay(record.startedAt),
            };
          },
        );
      } catch (err) {
        failed += 1;
        logger.warn(
          { runId, err },
          "cost.price-book-reprice: run rollup failed after its retries",
        );
        continue;
      }
      if (day) {
        repriced += 1;
        days.set(`${day.workspaceId}:${day.day}`, day);
      }
    }
    for (const target of days.values()) {
      await step.run(`daily-${target.workspaceId}-${target.day}`, () =>
        rebuildDailyTotals(target),
      );
    }

    const last = page.at(-1);
    const more = page.length === REPRICE_PAGE && last !== undefined;
    if (more)
      await step.sendEvent("next-page", {
        name: PRICE_BOOK_BACKDATED_EVENT,
        data: { after: last },
      });

    logger.info(
      {
        pending: page.length,
        repriced,
        failed,
        workspaceDays: days.size,
        more,
      },
      "cost.price-book-reprice: re-rolled a page of runs the backdated prices can price",
    );
    return {
      pending: page.length,
      repriced,
      failed,
      workspaceDays: days.size,
      more,
    };
  },
);
