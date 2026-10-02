/**
 * standing-context-price-store.ts — the workspace's weekly price per 1,000
 * tokens of standing context, priced from the book by call time (spec
 * detector 2). The pure arithmetic is ./standing-context-price.ts
 * `tallyWeek` and `weeklyPriceOfTally`.
 *
 * The requests are the workspace's model calls of the last 7 days, read from
 * the gateway's and the wrapped agents' frames by the call-bucket read
 * (`readObservedModels` with `callBuckets` in @oxagen/telemetry). The read
 * filters on each call's own time, so a run that started before the week and
 * ran into it counts only its calls inside the week. It splits each model's
 * calls at the instants the book's rate for that model could change, and
 * counts the calls in each bucket that read the cache. Each bucket's cache
 * reads are priced at the read rate in force inside it, and its other calls
 * at the input rate in force inside it, the way ./cache-savings.ts prices a
 * saving. The tool and steering pages quote this one price, so a provider and
 * a record of the same size cost the same.
 *
 * The read walks every model in keyset pages, so a workspace that ran more
 * models than one page holds is priced in full. Each page gets its own slice
 * of the book, as ./unpriced-models.ts does.
 *
 * Runs in tenant scope: the book slice is read through `withTenantDb`.
 */
import { readObservedModels } from "@oxagen/telemetry";
import {
  loadPriceBookSliceInTenantScope,
  priceBookBoundaries,
  type PriceBook,
} from "./price-book";
import {
  emptyWeekTally,
  STANDING_CONTEXT_WEEK_DAYS,
  tallyWeek,
  WEEKLY_PRICE_TOKEN_CLASSES,
  weeklyPriceOfTally,
  type WeeklyContextPrice,
} from "./standing-context-price";
import { compareModelIds } from "./unpriced-models";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many models one page of the frame read holds. The price walks every
 * page, so this bounds the memory and the `models` array of one bucket read,
 * not which models are priced.
 */
export const WEEKLY_PRICE_READ_PAGE_SIZE = 1_000;

/**
 * The weekly price per 1,000 tokens for one workspace. Null when the week
 * made no request, when the book has no rate for one of its requests, or when
 * its rates name more than one currency.
 */
export async function readWeeklyContextPrice(
  scope: { orgId: string; workspaceId: string },
  now: Date = new Date(),
): Promise<WeeklyContextPrice | null> {
  const since = new Date(now.getTime() - STANDING_CONTEXT_WEEK_DAYS * DAY_MS);
  // The read's upper bound is inclusive, so the week ends 1 ms before now.
  const until = new Date(now.getTime() - 1);
  const tally = emptyWeekTally();
  let afterModel: string | undefined;
  for (;;) {
    // The rows that could price this page's models. The read returns no rows
    // without calling `boundariesFor`, so an empty page leaves the book empty
    // and prices nothing.
    let book: PriceBook = [];
    const observed = await readObservedModels({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      since,
      until,
      page: { afterModel, size: WEEKLY_PRICE_READ_PAGE_SIZE },
      callBuckets: true,
      boundariesFor: async (models) => {
        book = await loadPriceBookSliceInTenantScope({
          orgId: scope.orgId,
          models,
          from: since,
          to: until,
        });
        return priceBookBoundaries(book, {
          models,
          tokenClasses: WEEKLY_PRICE_TOKEN_CLASSES,
          since,
          until,
        }).map((t) => new Date(t));
      },
    });
    tallyWeek(tally, {
      observed: observed.map((row) => ({
        model: row.model,
        calls: row.calls,
        buckets: row.callBuckets ?? [],
      })),
      book,
      orgId: scope.orgId,
    });
    if (observed.length < WEEKLY_PRICE_READ_PAGE_SIZE) break;
    const last = observed.at(-1)!.model;
    // The store returns a page in model-id order after `afterModel`, so the
    // cursor always moves forward. A page that does not move it would repeat
    // forever, and that is a store defect to surface, not to loop on.
    if (afterModel !== undefined && compareModelIds(last, afterModel) <= 0)
      throw new Error(
        `readWeeklyContextPrice: observed-model page did not advance past ${JSON.stringify(afterModel)}`,
      );
    afterModel = last;
  }
  const price = weeklyPriceOfTally(tally);
  return price === null ? null : { ...price, since };
}
