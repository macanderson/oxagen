import {
  type IncompleteCostRun,
  listRunsWithIncompleteCost,
  rebuildDailyTotals,
  rebuildRunTotals,
  utcDay,
} from "@oxagen/billing";
import { NonRetriableError } from "@oxagen/functions";
import { createFunction } from "../create-function";
import { PRICE_BOOK_BACKDATED_EVENT } from "../events";
import { logger } from "../logger";

/**
 * The event every backdated write sends — the hourly `cost.price-book-sync`
 * job, a manual `pnpm billing:price-book-sync --apply`, and this function to
 * itself once per page. The nightly `cost.daily-rollup` sends it too, which is
 * this pass's one recurring trigger. It lives in `../events` so a caller outside this
 * package can name it without importing this module's dependencies, and is
 * re-exported here because this is the function that consumes it.
 */
export { PRICE_BOOK_BACKDATED_EVENT };

/**
 * Runs re-rolled per invocation, carried-forward retries included. Each run
 * is one step and each workspace-day it touched is one more, so a page costs
 * at most three times this plus two, including one findings event per workspace,
 * under Inngest's 1,000 steps per function run.
 * The retries count against the page for exactly that reason: however many
 * runs a bad invocation carries, the next one still rebuilds at most this
 * many.
 */
const REPRICE_PAGE = 250;

/**
 * How many invocations may retry one run before it is dropped. Each attempt
 * is itself retried `retries` times inside its own step, so a frame store
 * that is merely slow recovers long before this. The bound is what stops one
 * permanently broken run from carrying itself forward for ever.
 */
const MAX_ATTEMPTS = 3;

type WorkspaceDay = { orgId: string; workspaceId: string; day: string };

/** A run whose rebuild failed, carried to the next invocation to be tried again. */
interface RetryRun {
  runId: string;
  /** How many invocations have already failed on it; 1 after the first failure. */
  attempt: number;
}

function malformed(what: string): NonRetriableError {
  return new NonRetriableError(
    `${PRICE_BOOK_BACKDATED_EVENT} carries a malformed ${what}`,
  );
}

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
    throw malformed("cursor");
  return { runId, startedAt };
}

/**
 * The runs a previous invocation failed on. The attempt counter is read but
 * not bounded here: a deploy that lowers {@link MAX_ATTEMPTS} would otherwise
 * make every in-flight event malformed, and the drop below applies the
 * current bound anyway.
 */
function readRetries(data: unknown): RetryRun[] {
  const raw = (data as { retry?: unknown } | null)?.retry;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > REPRICE_PAGE)
    throw malformed("retry list");
  const entries: unknown[] = raw;
  return entries.map((entry) => {
    const { runId, attempt } = (entry ?? {}) as Partial<RetryRun>;
    if (
      typeof runId !== "string" ||
      runId.length === 0 ||
      typeof attempt !== "number" ||
      !Number.isInteger(attempt) ||
      attempt < 1
    )
      throw malformed("retry list");
    return { runId, attempt };
  });
}

/**
 * `cost/price-book.backdated` → re-roll every run whose cost is blank,
 * `estimated`, or missing an unpriced frame, one page per invocation, until
 * the list is empty. Sent by a sync that backdated rows, and once a night by
 * `cost.daily-rollup` whether or not a price moved.
 *
 * The sync used to re-roll the first 500 such runs inline and stop. The next
 * hourly sync of an unchanged book writes nothing and is not backdated, so it
 * never re-rolled again, and an installation with more than 500 incomplete
 * runs kept the rest blank.
 *
 * Each invocation reads one page after the event's cursor, rebuilds those
 * runs and the workspace-days they started on, requests findings once for each
 * affected workspace, and sends itself the next
 * cursor when the page was full. The cursor matters: a run whose model no
 * source prices is still incomplete after its rebuild, so reading the head
 * of the list again would return the same page.
 *
 * A rebuild that throws is retried as a step, with Inngest's backoff, up to
 * `retries` times. A run that still fails is carried in the next event's
 * `retry` list and rebuilt first on the next invocation, because the chain
 * moves its cursor past it and nothing else would come back for it within
 * the night: an unchanged hourly sync starts no new pass, so a moment of
 * frame-store trouble would otherwise leave the run unpriced until the
 * nightly sweep asked for the next pass. A run that fails {@link MAX_ATTEMPTS}
 * invocations running is dropped with a warning, so one broken run cannot
 * keep the chain alive by itself.
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
    const retries = readRetries(event.data);
    const limit = Math.max(0, REPRICE_PAGE - retries.length);
    const page =
      limit === 0
        ? []
        : await step.run("list-incomplete-runs", () =>
            listRunsWithIncompleteCost({ limit, after }),
          );

    // The carried runs go first: a run that has already waited a whole
    // invocation is rebuilt before the page that displaced it.
    const work: RetryRun[] = [
      ...retries,
      ...page.map(({ runId }) => ({ runId, attempt: 0 })),
    ];

    let repriced = 0;
    let dropped = 0;
    const carried: RetryRun[] = [];
    const days = new Map<string, WorkspaceDay>();
    for (const { runId, attempt } of work) {
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
        const next = attempt + 1;
        if (next >= MAX_ATTEMPTS) {
          dropped += 1;
          logger.warn(
            { runId, attempts: next, err },
            "cost.price-book-reprice: run rollup failed on every attempt, dropping it",
          );
        } else {
          carried.push({ runId, attempt: next });
          logger.warn(
            { runId, attempt: next, err },
            "cost.price-book-reprice: run rollup failed after its retries, carrying it to the next invocation",
          );
        }
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

    const workspaces = new Map<string, WorkspaceDay>();
    for (const target of days.values())
      workspaces.set(`${target.orgId}:${target.workspaceId}`, target);
    for (const target of workspaces.values()) {
      await step.sendEvent(`findings-${target.orgId}-${target.workspaceId}`, {
        name: "cost/findings.requested",
        data: { orgId: target.orgId, workspaceId: target.workspaceId },
      });
    }

    const last = page.at(-1);
    // A page the retries crowded out entirely leaves the list unread, so the
    // chain has to go on whatever the page says.
    const more = limit === 0 || (page.length === limit && last !== undefined);
    const failed = carried.length + dropped;
    if (more || carried.length > 0)
      await step.sendEvent("next-page", {
        name: PRICE_BOOK_BACKDATED_EVENT,
        // An unfull page is the end of the list, so the cursor stays where it
        // is and the next invocation exists only to retry what it carries.
        data: { after: last ?? after, retry: carried },
      });

    const result = {
      pending: page.length,
      retried: retries.length,
      repriced,
      failed,
      dropped,
      carried: carried.length,
      workspaceDays: days.size,
      more,
    };
    logger.info(
      result,
      "cost.price-book-reprice: re-rolled a page of runs the backdated prices can price",
    );
    return result;
  },
);
