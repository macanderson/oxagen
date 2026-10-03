import { createFunction } from "../create-function";
import { FORGE_PULL_REQUEST_OBSERVED_EVENT } from "../events";
import {
  FORGE_BACKFILL_SOURCES,
  type ForgeBackfillPage,
  forgeBackfillRunner,
} from "../lib/forge-pull-request-backfill-runner";
import { logger } from "../logger";

/** Rows read per page. */
export const FORGE_BACKFILL_PAGE_SIZE = 500;
/**
 * Pages read per source per run. Every run starts again from the oldest row,
 * because a row with a forge row is skipped in code, not in the query, so no
 * cursor carries over. A store larger than this bound has rows no run reads.
 */
export const FORGE_BACKFILL_MAX_PAGES = 20;

/**
 * Move the pull request links recorded before the forge store existed into
 * it (ADR-292).
 *
 * A run's `tacho.run_pull_requests` rows and a work order's `pr_linked`
 * facts name pull requests that may have no `forge.pull_requests` row, and
 * the pull request reads fall back to those stores until every link has
 * one. Every 15 minutes this job reads each store by id, a page at a time,
 * and sends one `forge/pull-request.observed` event for each link whose pull
 * request has no forge row in its workspace. The sync writes the row, the
 * head's diff, and the link to the run or the work order. Sending an event
 * twice is safe:
 *
 * - The event id names the link, so Inngest drops a repeat for 24 hours.
 * - Once the sync writes the forge row, the next run no longer selects it.
 * - The sync upserts the row and its links, so a repeat writes nothing new.
 *
 * A run reads at most `FORGE_BACKFILL_MAX_PAGES` pages of each store, oldest
 * first, and logs a warning when it stops at that bound. The runner is
 * installed by `@oxagen/handlers/register`.
 */
export const [forgePullRequestBackfill] = createFunction(
  {
    id: "forge/pull-request-backfill",
    retries: 1,
    concurrency: { limit: 1 },
  },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    let read = 0;
    let requested = 0;
    const bounded: string[] = [];
    for (const source of FORGE_BACKFILL_SOURCES) {
      let after: string | null = null;
      for (let page = 0; page < FORGE_BACKFILL_MAX_PAGES; page++) {
        const cursor = after;
        const request = {
          source,
          after: cursor,
          limit: FORGE_BACKFILL_PAGE_SIZE,
        };
        // Typed, because the cursor comes from the previous page's answer. An
        // inferred type would depend on itself, and TypeScript reads it as any.
        const found: ForgeBackfillPage = await step.run(
          `read-${source}-${String(page)}`,
          () => forgeBackfillRunner()(request),
        );
        read += found.read;
        if (found.events.length > 0) {
          await step.sendEvent(
            `observe-${source}-${String(page)}`,
            found.events.map((event) => ({
              name: FORGE_PULL_REQUEST_OBSERVED_EVENT,
              id: event.id,
              data: event.data,
            })),
          );
          requested += found.events.length;
        }
        if (found.last === null || found.read < FORGE_BACKFILL_PAGE_SIZE)
          break;
        if (page === FORGE_BACKFILL_MAX_PAGES - 1) bounded.push(source);
        after = found.last;
      }
    }
    if (bounded.length > 0)
      logger.warn(
        { sources: bounded, pages: FORGE_BACKFILL_MAX_PAGES },
        "forge.pull-request-backfill: stopped at the page bound, so no run reads the rows past it; raise the bound or retire the fallbacks",
      );
    return { read, requested, bounded };
  },
);
