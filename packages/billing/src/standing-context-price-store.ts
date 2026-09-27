/**
 * standing-context-price-store.ts — the workspace's weekly price per 1,000
 * tokens of standing context, priced from the book by call time (spec
 * detector 2). The pure arithmetic is ./standing-context-price.ts
 * `weeklyPriceFromBook`.
 *
 * The requests are the workspace's model calls of the last 7 days, read from
 * the gateway's and the wrapped agents' frames by the class-bucket read
 * (`readObservedModels` in @oxagen/telemetry). The read filters on each
 * call's own time, so a run that started before the week and ran into it
 * counts only its calls inside the week. It splits each model's calls at the
 * instants the book's rate for that model could change, and each bucket is
 * priced at the rate in force inside it, the way ./cache-savings.ts prices a
 * saving. The tool and steering pages quote this one price, so a provider and
 * a record of the same size cost the same.
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
  STANDING_CONTEXT_WEEK_DAYS,
  WEEKLY_PRICE_TOKEN_CLASSES,
  weeklyPriceFromBook,
  type WeeklyContextPrice,
} from "./standing-context-price";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The weekly price per 1,000 tokens for one workspace; null when the week
 * made no request the book could price, or its rates name more than one
 * currency.
 */
export async function readWeeklyContextPrice(
  scope: { orgId: string; workspaceId: string },
  now: Date = new Date(),
): Promise<WeeklyContextPrice | null> {
  const since = new Date(now.getTime() - STANDING_CONTEXT_WEEK_DAYS * DAY_MS);
  // The read's upper bound is inclusive, so the week ends 1 ms before now.
  const until = new Date(now.getTime() - 1);
  // The rows that could price the models the week ran. The read returns no
  // rows without calling `boundariesFor`, so a week with no calls leaves the
  // book empty and prices nothing.
  let book: PriceBook = [];
  const observed = await readObservedModels({
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    since,
    until,
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
  const price = weeklyPriceFromBook({ observed, book, orgId: scope.orgId });
  return price === null ? null : { ...price, since };
}
