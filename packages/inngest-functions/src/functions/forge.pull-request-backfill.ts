import { createHash } from "node:crypto";
import { createFunction } from "../create-function";
import { FORGE_PULL_REQUEST_OBSERVED_EVENT } from "../events";
import {
  FORGE_BACKFILL_SOURCES,
  type ForgeBackfillPage,
  type ForgeBackfillRange,
  forgeBackfillRunner,
} from "../lib/forge-pull-request-backfill-runner";
import { logger } from "../logger";

/** Rows read per page. */
export const FORGE_BACKFILL_PAGE_SIZE = 500;
/** Pages read per source per run, across both legs of the pass. */
export const FORGE_BACKFILL_MAX_PAGES = 20;
/** How long one start point holds: the cron's period. */
export const FORGE_BACKFILL_SLOT_MS = 15 * 60 * 1000;

/** A uuid as the 128-bit number its hex digits spell. */
function uuidValue(id: string): bigint {
  return BigInt(`0x${id.replaceAll("-", "")}`);
}

/** A 128-bit number written as a uuid. */
function uuidOf(value: bigint): string {
  const hex = value.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Where a run starts reading a source: a point between its lowest and
 * highest row id, picked by a hash of the 15-minute slot `now` falls in. A
 * row with a forge row is skipped in code, not in the query, so a pass that
 * always began at the lowest id would spend its page bound on the same rows
 * and never reach the rest. A start that moves each slot, with the wrap in
 * `sweep`, lets every row fall inside some run's bound.
 *
 * The point is taken between the ids the store holds, not across all uuids,
 * because ids are uuidv7: they begin with their creation time, so they sit
 * in a narrow band, and a start drawn from all uuids would almost always
 * fall above every row. Pure.
 */
export function backfillStart(range: ForgeBackfillRange, now: Date): string {
  const slot = Math.floor(now.getTime() / FORGE_BACKFILL_SLOT_MS);
  const digest = createHash("sha256")
    .update(`forge-backfill:${String(slot)}`)
    .digest("hex");
  // 48 bits of the digest, as a share of the range.
  const share = BigInt(`0x${digest.slice(0, 12)}`);
  const first = uuidValue(range.first);
  const span = uuidValue(range.last) - first;
  return uuidOf(first + (span * share) / 2n ** 48n);
}

/** One leg of a pass: rows above `after` and at or below `until`, where each is set. */
type Leg = { after: string | null; until: string | null };

/**
 * One pass over a source from `start`: the rows above it in id order, then,
 * once those run out, the rows from the lowest id up to and including it.
 * Each leg reads pages until one comes back short. Answers false when the
 * page bound ran out before both legs did. `read` reads one page.
 */
export async function sweep(
  start: string,
  read: (page: number, leg: Leg) => Promise<ForgeBackfillPage>,
): Promise<boolean> {
  const legs: Leg[] = [
    { after: start, until: null },
    { after: null, until: start },
  ];
  let page = 0;
  for (const leg of legs) {
    let after = leg.after;
    for (;;) {
      if (page === FORGE_BACKFILL_MAX_PAGES) return false;
      const found = await read(page, { after, until: leg.until });
      page += 1;
      if (found.last === null || found.read < FORGE_BACKFILL_PAGE_SIZE) break;
      after = found.last;
    }
  }
  return true;
}

/**
 * Move the pull request links recorded before the forge store existed into
 * it (ADR-292).
 *
 * A run's `tacho.run_pull_requests` rows and a work order's `pr_linked`
 * facts name pull requests that may have no `forge.pull_requests` row, and
 * the pull request reads fall back to those stores until every link has
 * one. Every 15 minutes this job reads each store a page at a time from a
 * start point that moves each run (`backfillStart`), wrapping round to the
 * lowest id, and sends one `forge/pull-request.observed` event for each link
 * whose pull request has no forge row in its workspace. The sync writes the
 * row, the head's diff, and the link to the run or the work order. Sending an
 * event twice is safe:
 *
 * - The event id names the link, so Inngest drops a repeat for 24 hours.
 * - Once the sync writes the forge row, the next run no longer selects it.
 * - The sync upserts the row and its links, so a repeat writes nothing new.
 *
 * A run reads at most `FORGE_BACKFILL_MAX_PAGES` pages of each store and logs
 * when it stops at that bound; the next run starts somewhere else. The start
 * is picked inside a step, so a replay of the run reads the same pages. The
 * runner is installed by `@oxagen/handlers/register`.
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
      const start = await step.run(
        `start-${source}`,
        async (): Promise<string | null> => {
          const range = await forgeBackfillRunner().range(source);
          return range === null ? null : backfillStart(range, new Date());
        },
      );
      if (start === null) continue;
      const complete = await sweep(start, async (page, leg) => {
        const request = { source, ...leg, limit: FORGE_BACKFILL_PAGE_SIZE };
        const found = await step.run(`read-${source}-${String(page)}`, () =>
          forgeBackfillRunner().page(request),
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
        return found;
      });
      if (!complete) bounded.push(source);
    }
    if (bounded.length > 0)
      logger.warn(
        { sources: bounded, pages: FORGE_BACKFILL_MAX_PAGES },
        "forge.pull-request-backfill: stopped at the page bound; the next run starts at another point",
      );
    return { read, requested, bounded };
  },
);
