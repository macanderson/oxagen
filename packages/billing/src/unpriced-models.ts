/**
 * unpriced-models.ts — the models this organization is running that nobody
 * has a price for.
 *
 * A frame whose model the price book cannot price is recorded `unpriced` by
 * the rollup (./cost-rollup.ts `priceFrame`): no cost, no basis, deliberately
 * never a zero. That is the honest answer, but on its own it is a silence —
 * the customer sees a run with a blank cost and no way to learn why. This is
 * the other half: name the model, say how much of it has been run, and say
 * what to do about it.
 *
 * "What to do about it" is one of two things, and which one depends on who is
 * reading:
 *  - an operator of the installation states the rate in the environment
 *    (./price-overrides.ts), and every organization gets it;
 *  - a customer with a rate they negotiated themselves states it as a
 *    `negotiated` row for their organization (`set_price_entry`), which wins
 *    over the list rate for them and nobody else.
 *
 * Pure. The frame reads live in @oxagen/telemetry and the book read in
 * ./price-book.ts; this module is the diff between them, so the tests can
 * exercise it without either store.
 */
import { loadPriceBook, resolvePriceEntry, type PriceBook } from "./price-book";
import { readObservedModels } from "@oxagen/telemetry";
import type { PriceTokenClass } from "@oxagen/database/schema";

/** One model seen in an organization's frames, as the frame stores report it. */
export interface ObservedModel {
  model: string;
  /** The vendor the frames name, when they name one. */
  provider: string | null;
  /** Model calls seen in the window. */
  calls: number;
  /** Total tokens across every class, for ranking by how much it matters. */
  tokens: number;
  firstSeen: Date;
  lastSeen: Date;
}

/** A model the book cannot fully price, and exactly which classes are missing. */
export interface UnpricedModel extends ObservedModel {
  /**
   * The token classes with no price entry. `input_uncached` and `output`
   * missing means the model is priced at nothing at all; a subset means the
   * run is recorded `estimated` rather than unpriced.
   */
  missingClasses: PriceTokenClass[];
  /** True when the book prices none of the classes — the run has no cost at all. */
  fullyUnpriced: boolean;
}

/**
 * The classes every token-metered model needs a price for. `cache_write_1h`
 * and `reasoning` are not in this set: a provider that has no one-hour cache
 * tier and no separately-metered reasoning tokens is not missing a price, and
 * listing every such model as a problem would bury the models that are.
 */
const REQUIRED_CLASSES: readonly PriceTokenClass[] = [
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "output",
];

/**
 * The instants at which the book's answer for a model can change between
 * `start` and `end`: the two ends, and every entry boundary strictly inside.
 * Whether a class is priced is constant between consecutive boundaries, so
 * probing these is probing the whole interval.
 */
function probeInstants(
  boundaries: readonly number[],
  start: Date,
  end: Date,
): Date[] {
  const lo = start.getTime();
  const hi = Math.max(lo, end.getTime());
  const out = [lo];
  for (const t of boundaries) if (t > lo && t < hi) out.push(t);
  if (hi > lo) out.push(hi);
  return out.map((t) => new Date(t));
}

/**
 * Which of `observed` the book cannot price, worst first — fully unpriced
 * models before partly-priced ones, then by tokens run, so the model costing
 * the most invisible money is at the top of the list.
 *
 * A class is missing when any call in the observation went unpriced, or
 * when it is unpriced at `at`. Judging the whole window by one snapshot at
 * `at` (which this once did) hid the case the tab exists for: a customer
 * states the first rate for a model AFTER it has produced unpriced calls,
 * the new row prices it from now on, and the earlier runs stay blank while
 * the tab reports no unpriced model to explain them. So each model is
 * probed at every instant its price could have changed between its first
 * and last call, and at `at`, and a class missing at any of them is named.
 */
export function findUnpricedModels(args: {
  observed: readonly ObservedModel[];
  book: PriceBook;
  orgId: string;
  at: Date;
}): UnpricedModel[] {
  const boundaries = [
    ...new Set(
      args.book.flatMap((e) => [
        e.effectiveFrom.getTime(),
        ...(e.effectiveTo === null ? [] : [e.effectiveTo.getTime()]),
      ]),
    ),
  ].sort((a, b) => a - b);
  const out: UnpricedModel[] = [];
  for (const model of args.observed) {
    // Calls after `at` are not in the observation (the store read is bounded
    // by it), so the window ends at the earlier of the last call and `at`.
    const end =
      model.lastSeen.getTime() < args.at.getTime() ? model.lastSeen : args.at;
    const instants = [
      ...probeInstants(boundaries, model.firstSeen, end),
      args.at,
    ];
    const missingClasses = REQUIRED_CLASSES.filter((tokenClass) =>
      instants.some(
        (at) =>
          resolvePriceEntry(args.book, {
            orgId: args.orgId,
            modelId: model.model,
            tokenClass,
            at,
          }) === null,
      ),
    );
    if (missingClasses.length === 0) continue;
    out.push({
      ...model,
      missingClasses,
      fullyUnpriced: missingClasses.length === REQUIRED_CLASSES.length,
    });
  }
  return out.sort((a, b) => {
    if (a.fullyUnpriced !== b.fullyUnpriced) return a.fullyUnpriced ? -1 : 1;
    if (a.tokens !== b.tokens) return b.tokens - a.tokens;
    return a.model.localeCompare(b.model);
  });
}

// ── Store ─────────────────────────────────────────────────────────────────────

/**
 * The models this organization has run since `since` that the book could
 * not fully price when they ran, or cannot at `at`, worst first.
 *
 * Reads the book through the system connection with an explicit org
 * predicate, the same way {@link loadPriceBook}'s other callers do: this is a
 * derived read over the list rows plus the organization's own, not a read of
 * a tenant's rows, and it must answer the same way whether or not a tenant
 * scope happens to be open.
 *
 * The frame read is a ClickHouse read that throws on a degraded store rather
 * than answering off half the frames — a model missing from the observation
 * would read as a model nobody needs a price for.
 */
export async function readUnpricedModels(args: {
  orgId: string;
  workspaceId?: string;
  since: Date;
  at: Date;
}): Promise<UnpricedModel[]> {
  const [book, observed] = await Promise.all([
    loadPriceBook({ orgId: args.orgId }),
    // Bounded above by `at` as well as below by `since`: the book is judged
    // as of `at`, so a model first run after `at` — and every later call and
    // token — would otherwise be reported against a snapshot from before it
    // ran, and read as unpriced when the book of its own time prices it.
    readObservedModels({
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      since: args.since,
      until: args.at,
    }),
  ]);
  return findUnpricedModels({
    observed: observed.map((row) => ({
      model: row.model,
      provider: row.provider,
      calls: row.calls,
      tokens: row.tokens,
      firstSeen: new Date(row.firstSeen),
      lastSeen: new Date(row.lastSeen),
    })),
    book,
    orgId: args.orgId,
    at: args.at,
  });
}
