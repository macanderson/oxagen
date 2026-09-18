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
 * Which of `observed` the book cannot price at `at`, worst first — fully
 * unpriced models before partly-priced ones, then by tokens run, so the
 * model costing the most invisible money is at the top of the list.
 */
export function findUnpricedModels(args: {
  observed: readonly ObservedModel[];
  book: PriceBook;
  orgId: string;
  at: Date;
}): UnpricedModel[] {
  const out: UnpricedModel[] = [];
  for (const model of args.observed) {
    const missingClasses = REQUIRED_CLASSES.filter(
      (tokenClass) =>
        resolvePriceEntry(args.book, {
          orgId: args.orgId,
          modelId: model.model,
          tokenClass,
          at: args.at,
        }) === null,
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
 * The models this organization has run since `since` that the book cannot
 * fully price at `at`, worst first.
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
    readObservedModels({
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      since: args.since,
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
