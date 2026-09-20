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
import {
  indexPriceBookByClass,
  loadPriceBook,
  priceBookBoundaries,
  resolvePriceEntryFromClassBook,
  type PriceBook,
} from "./price-book";
import { OBSERVED_TOKEN_CLASSES, readObservedModels } from "@oxagen/telemetry";
import type { PriceTokenClass } from "@oxagen/database/schema";

/**
 * One class an observed model actually used, within one price-boundary
 * bucket: how much of it ran, and the earliest/latest call in that bucket
 * that used it. Only classes and buckets that saw nonzero usage are ever
 * present — this is what `readObservedModels` reports, not a fixed list of
 * classes every model is judged against.
 */
export interface ObservedModelClassUsage {
  tokenClass: PriceTokenClass;
  calls: number;
  tokens: number;
  firstSeen: Date;
  lastSeen: Date;
}

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
  /** This model's usage broken out by class and price-boundary bucket. */
  classes: readonly ObservedModelClassUsage[];
}

/** One class this organization ran unpriced, and the span it ran unpriced over. */
export interface MissingClassWindow {
  tokenClass: PriceTokenClass;
  /** RFC 3339 equivalents kept as `Date`: the earliest and latest unpriced call. */
  unpricedFrom: Date;
  unpricedTo: Date;
}

/** A model the book cannot fully price, and exactly which classes are missing. */
export interface UnpricedModel extends ObservedModel {
  /**
   * The token classes this model actually used that have no price entry
   * covering the calls that used them. `input_uncached` and `output`
   * missing means the model is priced at nothing at all; a subset means the
   * run is recorded `estimated` rather than unpriced. A class the model
   * never used is never in this list, even when the book has no row for it
   * at all — the book cannot be missing a price for tokens nobody sent.
   */
  missingClasses: PriceTokenClass[];
  /**
   * The same classes, each with the span of its unpriced calls, so the
   * Pricing tab can say WHEN a class went unpriced rather than only that it
   * did — the answer to a rate that was added too late to cover every call.
   */
  missingClassWindows: MissingClassWindow[];
  /**
   * True when every usage bucket the model actually sent tokens in came back
   * unpriced — the run has no cost at all. A class with both a priced and an
   * unpriced bucket (a rate that expired and later came back) is NOT what
   * this flag tracks: that model has real cost from its priced bucket, so it
   * is `estimated`, not fully unpriced, even though the class itself appears
   * once in {@link missingClasses}.
   */
  fullyUnpriced: boolean;
}

/**
 * At most this many unpriced models are reported, fully unpriced first, then
 * by tokens run. This is the "how many the report shows" cap, applied AFTER
 * the price comparison below has already decided which models are unpriced —
 * never before it, and never as a cap on which models are compared in the
 * first place. Capping the observation itself, by volume, before pricing it
 * would let a low-volume unpriced model be silently outranked by higher-
 * volume priced ones and never reach this function's judgment at all, which
 * is the report claiming nothing is unpriced about an organization that has
 * exactly one unpriced model nobody happened to run much of.
 */
export const UNPRICED_MODEL_REPORT_LIMIT = 500;

/**
 * Which of `observed` the book cannot price for at least one class it
 * actually used, worst first — fully unpriced models before partly-priced
 * ones, then by tokens run, so the model costing the most invisible money is
 * at the top of the list.
 *
 * A class is checked only when the model's observation says it used it
 * (nonzero tokens in at least one bucket): a model with prices for input and
 * output but no cache rate is not reported for the cache classes it never
 * sent a token in, and `reasoning` is checked on the same footing as every
 * other class, so a model whose reasoning tokens make its runs `estimated`
 * is named instead of silently passing because the fixed list this function
 * used to check never mentioned it.
 *
 * Each bucket is probed once, at its own `firstSeen` — every call inside one
 * price-boundary bucket shares one book answer by construction
 * ({@link priceBookBoundaries}), so probing anywhere in the bucket probes the
 * whole bucket, and a bucket where the model made no call is never probed at
 * all. That is what removes the false positive a fixed-window scan across a
 * model's whole `firstSeen`..`lastSeen` used to produce: two priced calls
 * bracketing a lapse the model never actually called during no longer read
 * as an unpriced gap, because nothing was observed in that lapse's bucket.
 * The book is judged against the calls that actually happened when they
 * happened, not against one snapshot at a fixed instant applied to the whole
 * window — a rate added after a model's unpriced calls ran still names
 * those calls, and a model whose rate later lapsed with no calls during the
 * lapse is not falsely flagged for it.
 *
 * The book is indexed by class once ({@link indexPriceBookByClass}), so
 * probing model A's `reasoning` usage never rescans model B's `cache_read`
 * rows or price history for a model this organization never even ran.
 */
export function findUnpricedModels(args: {
  observed: readonly ObservedModel[];
  book: PriceBook;
  orgId: string;
  at: Date;
}): UnpricedModel[] {
  const byClass = indexPriceBookByClass(args.book);
  const out: UnpricedModel[] = [];
  for (const model of args.observed) {
    // Counted per (class, bucket) usage occurrence, not per distinct class:
    // a class with both a priced and an unpriced bucket (a rate that
    // expired, then lapsed, then came back) must not read as "this class is
    // missing" on the strength of its one unpriced bucket while its priced
    // bucket's cost is ignored. `fullyUnpriced` below asks whether EVERY
    // usage bucket missed, not whether every used class missed at least once.
    let usageBucketCount = 0;
    let missedUsageBucketCount = 0;
    const windowsByClass = new Map<PriceTokenClass, MissingClassWindow>();
    for (const usage of model.classes) {
      if (usage.tokens <= 0) continue;
      usageBucketCount++;
      const classBook = byClass.get(usage.tokenClass) ?? [];
      const priced =
        resolvePriceEntryFromClassBook(classBook, {
          orgId: args.orgId,
          modelId: model.model,
          // Every call in this bucket shares one book answer by
          // construction, so any instant inside it probes the whole bucket.
          at: usage.firstSeen,
        }) !== null;
      if (priced) continue;
      missedUsageBucketCount++;
      const existing = windowsByClass.get(usage.tokenClass);
      if (!existing) {
        windowsByClass.set(usage.tokenClass, {
          tokenClass: usage.tokenClass,
          unpricedFrom: usage.firstSeen,
          unpricedTo: usage.lastSeen,
        });
      } else {
        if (usage.firstSeen < existing.unpricedFrom)
          existing.unpricedFrom = usage.firstSeen;
        if (usage.lastSeen > existing.unpricedTo)
          existing.unpricedTo = usage.lastSeen;
      }
    }
    if (windowsByClass.size === 0) continue;
    const missingClassWindows = [...windowsByClass.values()].sort((a, b) =>
      a.tokenClass.localeCompare(b.tokenClass),
    );
    out.push({
      model: model.model,
      provider: model.provider,
      calls: model.calls,
      tokens: model.tokens,
      firstSeen: model.firstSeen,
      lastSeen: model.lastSeen,
      classes: model.classes,
      missingClasses: missingClassWindows.map((w) => w.tokenClass),
      missingClassWindows,
      fullyUnpriced: missedUsageBucketCount === usageBucketCount,
    });
  }
  return out
    .sort((a, b) => {
      if (a.fullyUnpriced !== b.fullyUnpriced) return a.fullyUnpriced ? -1 : 1;
      if (a.tokens !== b.tokens) return b.tokens - a.tokens;
      return a.model.localeCompare(b.model);
    })
    .slice(0, UNPRICED_MODEL_REPORT_LIMIT);
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
 *
 * The book is loaded first, not in parallel with the observation: its
 * boundaries ({@link priceBookBoundaries}) are what the observed-usage read
 * buckets calls by, so the book must be in hand before that read is made.
 * Which boundaries, though, is decided inside that read, once its summary
 * query has named the models this organization actually ran: only the rows
 * that could price one of those models, in a class a token read can even
 * observe, contribute one. The whole book's history would make every frame
 * scan every rate change any model has ever had.
 */
export async function readUnpricedModels(args: {
  orgId: string;
  workspaceId?: string;
  since: Date;
  at: Date;
}): Promise<UnpricedModel[]> {
  const book = await loadPriceBook({ orgId: args.orgId });
  // Bounded above by `at` as well as below by `since`: the book is judged
  // as of `at`, so a model first run after `at` — and every later call and
  // token — would otherwise be reported against a snapshot from before it
  // ran, and read as unpriced when the book of its own time prices it.
  const observed = await readObservedModels({
    orgId: args.orgId,
    workspaceId: args.workspaceId,
    since: args.since,
    until: args.at,
    // The boundaries are chosen from the models the window actually holds,
    // not from the whole book: `loadPriceBook` returns every list row's full
    // history plus the organization's own, and that array is rescanned for
    // every frame. An organization that ran one model paid for every other
    // model's rate changes, and had its one model's report split into buckets
    // whose price answer is identical on both sides of the split.
    boundariesFor: (models) =>
      priceBookBoundaries(book, {
        models,
        tokenClasses: OBSERVED_TOKEN_CLASSES,
        since: args.since,
        until: args.at,
      }).map((t) => new Date(t)),
  });
  return findUnpricedModels({
    observed: observed.map((row) => ({
      model: row.model,
      provider: row.provider,
      calls: row.calls,
      tokens: row.tokens,
      firstSeen: new Date(row.firstSeen),
      lastSeen: new Date(row.lastSeen),
      classes: row.classes.map((c) => ({
        tokenClass: c.tokenClass,
        calls: c.calls,
        tokens: c.tokens,
        firstSeen: new Date(c.firstSeen),
        lastSeen: new Date(c.lastSeen),
      })),
    })),
    book,
    orgId: args.orgId,
    at: args.at,
  });
}
