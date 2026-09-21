/**
 * price-book.ts — the price book as data (Mission Control spec §12.2, ADR-060).
 *
 * `cost.price_entries` holds every price Oxagen applies to a frame. The list
 * rows (org_id NULL, source `list`) are derived from the in-code rate cards in
 * ./pricing.ts by {@link priceEntriesFromRateCards} and written by
 * {@link syncPriceBook} (`pnpm billing:price-book-sync`); an organization's
 * negotiated rows carry its org_id and win over the list row for the same
 * model and class. A price is effective over [effective_from, effective_to);
 * a correction is a new row with a later effective_from, so every cost record
 * can name the entry it was priced with.
 *
 * The rollup (./cost-rollup.ts) resolves a frame's model and token class to
 * one entry with {@link resolvePriceEntry}: the org's rows first, then the
 * list, by longest prefix over `model` and `model_aliases`, in the two shapes
 * a model id reaches billing in (bare `claude-sonnet-5`, gateway
 * `anthropic/claude-sonnet-5`), the same two passes ./pricing.ts makes. No
 * match is a miss: the caller records the frame as `estimated`.
 *
 * `providerCostUsdMicros` keeps charging credits from the in-code card; the
 * card is the price book's seed and the recorder's rate until the rollup is
 * the only reader (ADR-060 §1).
 */
import { schema, withSystemDb, withTenantDb, type Tx } from "@oxagen/database";
// The narrow entry point, never the package root. `@oxagen/oxagen`'s index
// re-exports the whole contracts barrel, and one contract (`org.create`)
// imports `@oxagen/config`, whose registry reads `baseEnvSchema` at module
// load. Importing the root from here dragged every contract into every graph
// that touches billing — which is nearly all of them — and broke each test
// suite that partially mocks `@oxagen/config/env`, for the sake of one class.
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { PRICE_BOOK_LIST } from "@oxagen/database/schema";
import type { PriceTokenClass, PriceUnit } from "@oxagen/database/schema";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { isSameModelIdentity } from "./model-identity";
import {
  IMAGE_RATE_CARD,
  PROVIDER_RATE_CARD,
  VIDEO_RATE_CARD,
  type ImageModelRate,
  type RateCard,
  type VideoModelRate,
} from "./pricing";

export type { PriceTokenClass, PriceUnit } from "@oxagen/database/schema";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * The instant a cold book's first snapshot is effective from: before any
 * frame Oxagen could have recorded, so a run accepted before the first sync
 * still resolves a price on its next rollup. See {@link syncPriceBook}.
 */
export const COLD_BOOK_EFFECTIVE_FROM = new Date("2020-01-01T00:00:00.000Z");

/**
 * How long after the price book's first row a newly seen model is still
 * backdated to {@link COLD_BOOK_EFFECTIVE_FROM}. Seven days covers a catalog
 * that was down when the book was first written. After it, a new model is
 * priced from the instant it appeared, never retroactively.
 */
export const COLD_START_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The instant a scheduled sync's prices take effect: the next top of the hour
 * after `now`, never `now` itself.
 *
 * `now` is read before the catalogs are fetched and before the transaction
 * commits. Any frame rolled up in that window is priced against the OLD row,
 * and when the sync then closes that row at `now` and opens its successor from
 * `now`, the frame's stored cost cites an entry whose window no longer covers
 * it — and a retry of the rollup quietly reprices it at the new rate. A future
 * boundary cannot be observed early: every rollup before it reads the old row,
 * whose window still covers it after the commit, and every rollup after it
 * reads the successor.
 *
 * A whole hour is far longer than a sync takes and matches the job's cadence,
 * and it is stable within the hour, so a retry of the same tick writes the
 * same instant and the row-key upsert stays idempotent.
 */
export function nextPriceBookBoundary(now: Date): Date {
  // A boundary only milliseconds ahead is no boundary: the catalog reads can
  // take fifteen seconds and the transaction more, and if the top of the hour
  // passes before the commit, frames rolled up in that gap were priced
  // against a row the commit then closes behind them, which is the defect the
  // boundary exists to prevent. So the boundary has to be at least
  // BOUNDARY_MARGIN_MS ahead of `now`, and a run that starts inside the last
  // margin of an hour takes the hour after.
  const next = new Date(now.getTime() + BOUNDARY_MARGIN_MS);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next;
}

/**
 * How far ahead of the run a boundary must be to hold through the run. Well
 * past the slowest refresh observed (catalog reads bounded at fifteen
 * seconds, plus the transaction), and short next to the hour it may push the
 * boundary by.
 */
export const BOUNDARY_MARGIN_MS = 5 * 60 * 1000;

/**
 * How far before the write instant a negotiated rate may start and still be
 * "now": the instant a caller took before its request, less request latency
 * and clock skew. Anything older is a backdating and is refused, because a
 * start in the past reprices frames already settled at the list price.
 */
export const PAST_START_GRACE_MS = 5 * 60 * 1_000;

/** One resolved price: what the rollup multiplies a frame's units by. */
export interface PriceEntry {
  id: string;
  /** Null for a list price; the organization for a negotiated row. */
  orgId: string | null;
  provider: string;
  model: string;
  modelAliases: readonly string[];
  region: string | null;
  tokenClass: PriceTokenClass;
  unit: PriceUnit;
  currency: string;
  /** Integer micro-USD per one million units. */
  microsPerMillion: bigint;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  source: "list" | "negotiated" | "override";
}

/** A list row before it has an id: the seed shape ./pricing.ts produces. */
/**
 * A list row before it has an id. `source` says who published it: `list`
 * for a catalog or the in-code card, `override` for an operator's negotiated
 * installation rate. Both live with a null org, and the difference is what
 * lets a withdrawn override retire while a catalog is down.
 */
export type PriceEntrySeed = Omit<PriceEntry, "id" | "orgId" | "source"> & {
  source?: "list" | "override";
  /** The catalog that published this seed; see the column's docblock. */
  catalog?: string;
};

/** Every price the seed writes for one token-card row. */
const TOKEN_CLASS_FIELDS = [
  ["input_uncached", "inputPer1M"],
  ["cache_read", "cachedInputPer1M"],
  ["cache_write_5m", "cacheWritePer1M"],
  ["output", "outputPer1M"],
] as const;

const MILLION = 1_000_000n;

/** USD per one million units → integer micro-USD per one million units. */
export function usdPerMillionToMicros(usdPerMillion: number): bigint {
  if (!Number.isFinite(usdPerMillion) || usdPerMillion < 0)
    throw new RangeError(`a price must be a finite non-negative USD figure`);
  return BigInt(Math.round(usdPerMillion * 1_000_000));
}

/** USD per one unit → integer micro-USD per one million units. */
export function usdPerUnitToMicrosPerMillion(usdPerUnit: number): bigint {
  return usdPerMillionToMicros(usdPerUnit) * MILLION;
}

/**
 * The list price book the in-code rate cards describe, effective from
 * `effectiveFrom`. Pure: the sync script and its test call it the same way.
 * Media rows carry the base per-asset price; a size multiplier is a call-time
 * factor the frame reader applies when media frames exist.
 */
export function priceEntriesFromRateCards(
  effectiveFrom: Date,
  cards: {
    tokens?: RateCard;
    images?: Record<string, ImageModelRate>;
    videos?: Record<string, VideoModelRate>;
  } = {},
): PriceEntrySeed[] {
  const tokens = cards.tokens ?? PROVIDER_RATE_CARD;
  const images = cards.images ?? IMAGE_RATE_CARD;
  const videos = cards.videos ?? VIDEO_RATE_CARD;
  const rows: PriceEntrySeed[] = [];
  for (const [model, rate] of Object.entries(tokens)) {
    for (const [tokenClass, field] of TOKEN_CLASS_FIELDS) {
      rows.push({
        provider: rate.provider,
        model,
        modelAliases: [],
        region: null,
        tokenClass,
        unit: "token",
        currency: "USD",
        microsPerMillion: usdPerMillionToMicros(rate[field]),
        effectiveFrom,
        effectiveTo: null,
      });
    }
  }
  for (const [model, rate] of Object.entries(images)) {
    rows.push({
      provider: rate.vendor,
      model,
      modelAliases: [],
      region: null,
      tokenClass: "image",
      unit: "image",
      currency: "USD",
      microsPerMillion: usdPerUnitToMicrosPerMillion(rate.usdPerImage),
      effectiveFrom,
      effectiveTo: null,
    });
  }
  for (const [model, rate] of Object.entries(videos)) {
    rows.push({
      provider: rate.vendor,
      model,
      modelAliases: [],
      region: null,
      tokenClass: "video_second",
      unit: "second",
      currency: "USD",
      microsPerMillion: usdPerUnitToMicrosPerMillion(rate.usdPerSecond),
      effectiveFrom,
      effectiveTo: null,
    });
  }
  return rows;
}

// ── Resolution ────────────────────────────────────────────────────────────────

/** The rows the rollup resolves against: the org's own plus the list. */
export type PriceBook = readonly PriceEntry[];

function effectiveAt(entry: PriceEntry, at: Date): boolean {
  return (
    entry.effectiveFrom.getTime() <= at.getTime() &&
    (entry.effectiveTo === null || at.getTime() < entry.effectiveTo.getTime())
  );
}

/**
 * The longest of an entry's names that names the same model as `modelId`, or
 * null.
 *
 * The test is {@link isSameModelIdentity}, not a prefix test of any kind. An
 * entry's name reaches another model id only through an explicit alias or a
 * point-in-time stamp, because the resolver reads the organization's rows
 * before the list rows and returns the first name that matched — so a name
 * that over-claims never reaches the more specific list row, and the
 * organization is billed its negotiated rate for a product it did not
 * negotiate. `gpt-4` over-claiming `gpt-4o` billed a frontier model at an
 * older model's contracted rate; `gpt-4o` over-claiming `gpt-4o-mini` billed a
 * tenth-price model at the frontier rate; `gpt-5` over-claiming `gpt-5.2` and
 * `gpt-5.5` billed two separately priced products at a third one's rate.
 * `gpt-4-0613` and `claude-sonnet-5-20260901` are the same products at a
 * stamped moment, which is what the stamp rule admits and all it admits.
 */
function matchLength(entry: PriceEntry, modelId: string): number | null {
  let best: number | null = null;
  for (const name of [entry.model, ...entry.modelAliases]) {
    if (isSameModelIdentity(modelId, name)) {
      if (best === null || name.length > best) best = name.length;
    }
  }
  return best;
}

function bestMatch(
  candidates: readonly PriceEntry[],
  modelId: string,
): PriceEntry | null {
  let best: { entry: PriceEntry; length: number } | null = null;
  for (const entry of candidates) {
    const length = matchLength(entry, modelId);
    if (length === null) continue;
    if (
      !best ||
      length > best.length ||
      // Among equal-length matches the latest effective row wins.
      (length === best.length &&
        entry.effectiveFrom.getTime() > best.entry.effectiveFrom.getTime())
    )
      best = { entry, length };
  }
  return best?.entry ?? null;
}

/**
 * The entry that prices `modelId`'s `tokenClass` at `at` for `orgId`: the
 * organization's negotiated rows first, then the list rows; within each, the
 * longest prefix over model and aliases, tried on the id as given and then
 * on the bare family behind a `creator/` prefix. Null when nothing prices
 * it, which the rollup records as `estimated`.
 */
export function resolvePriceEntry(
  book: PriceBook,
  args: {
    orgId: string;
    modelId: string;
    tokenClass: PriceTokenClass;
    at: Date;
  },
): PriceEntry | null {
  const classBook = book.filter((e) => e.tokenClass === args.tokenClass);
  return resolvePriceEntryFromClassBook(classBook, args);
}

/**
 * {@link resolvePriceEntry}'s matching, over a book already narrowed to one
 * token class. A caller resolving many (model, at) pairs for the same class —
 * `findUnpricedModels` probing one observed model's usage buckets — filters
 * the whole book by class once with {@link indexPriceBookByClass} and calls
 * this for every probe, instead of rescanning every other class's rows (and
 * every other model's boundaries) on each one.
 */
export function resolvePriceEntryFromClassBook(
  classBook: PriceBook,
  args: {
    orgId: string;
    modelId: string;
    at: Date;
  },
): PriceEntry | null {
  const live = classBook.filter((e) => effectiveAt(e, args.at));
  const own = live.filter((e) => e.orgId === args.orgId);
  const list = live.filter((e) => e.orgId === null);
  const slash = args.modelId.indexOf("/");
  const family = slash >= 0 ? args.modelId.slice(slash + 1) : null;
  for (const candidates of [own, list]) {
    const direct = bestMatch(candidates, args.modelId);
    if (direct) return direct;
    if (family !== null) {
      const byFamily = bestMatch(candidates, family);
      if (byFamily) return byFamily;
    }
  }
  return null;
}

/**
 * `book` grouped by token class, once. {@link resolvePriceEntry} rescans the
 * whole book to find one class's rows on every call; a caller that probes
 * many (model, class, instant) triples over the same book — the unpriced-model
 * read — builds this once and passes each class's slice to
 * {@link resolvePriceEntryFromClassBook}, so probing model A's `reasoning`
 * usage never rescans model B's `cache_read` rows or an unrelated model's
 * price-boundary history.
 */
export function indexPriceBookByClass(
  book: PriceBook,
): ReadonlyMap<PriceTokenClass, PriceBook> {
  const out = new Map<PriceTokenClass, PriceEntry[]>();
  for (const entry of book) {
    const list = out.get(entry.tokenClass);
    if (list) list.push(entry);
    else out.set(entry.tokenClass, [entry]);
  }
  return out;
}

/**
 * True when `entry` is one of the rows {@link resolvePriceEntryFromClassBook}
 * would even consider for `modelId`: a name match on the id as given, or on
 * the bare family behind a `creator/` prefix, which is the same fallback the
 * resolver applies. An entry this answers false for can never be the book's
 * answer for that model, at any instant.
 */
function entryCouldPrice(entry: PriceEntry, modelId: string): boolean {
  if (matchLength(entry, modelId) !== null) return true;
  const slash = modelId.indexOf("/");
  if (slash < 0) return false;
  return matchLength(entry, modelId.slice(slash + 1)) !== null;
}

/**
 * The instants, in ascending order, at which the book's answer could change
 * for the (model, class) pairs `filter` names: the two ends of every entry's
 * effective window. The book's answer is constant between two consecutive
 * boundaries, so a caller bucketing observed usage by these boundaries
 * (`readObservedModels`'s `boundariesFor` argument) groups every call whose
 * price-book answer could not have differed, and probing once per bucket is
 * probing the whole bucket.
 *
 * `filter` is how a report asks for its own boundaries rather than the
 * catalog's whole history, and it is a correctness matter as well as a cost
 * one. The observed-usage read scans this array once per frame, so every
 * boundary an unrelated model's rate change contributes is both a per-frame
 * scan the report pays for and an extra bucket split off a model whose price
 * answer is identical on both sides of it. With the catalog growing on every
 * sync, an unfiltered list is O(frames × all history) and eventually a
 * timeout.
 *
 * - `models` keeps only the entries that could price one of those model ids,
 *   by the resolver's own matching ({@link entryCouldPrice}) — never a loose
 *   prefix test, so the narrowing cannot drop a boundary the resolver would
 *   have honoured.
 * - `tokenClasses` keeps only those classes' rows, for a caller that can
 *   observe some of the eleven and never the rest: a token read never reports
 *   `image` or `video_second` usage, so those rows' boundaries can only ever
 *   split a bucket nobody probes.
 * - `since` and `until` retain only endpoints inside the inclusive observation
 *   window. Older and future changes cannot split any calls in that report.
 *   Filter endpoints, not rows: a rate that starts before the window can still
 *   end inside it, and that ending must separate the observed calls.
 *
 * Omitting a key leaves that dimension unnarrowed, and omitting `filter`
 * entirely returns every boundary in the book.
 */
export function priceBookBoundaries(
  book: PriceBook,
  filter?: {
    models?: readonly string[];
    tokenClasses?: readonly PriceTokenClass[];
    since?: Date;
    until?: Date;
  },
): number[] {
  const classes =
    filter?.tokenClasses === undefined ? null : new Set(filter.tokenClasses);
  const models = filter?.models;
  const since = filter?.since?.getTime() ?? -Infinity;
  const until = filter?.until?.getTime() ?? Infinity;
  const relevant = book.filter((e) => {
    if (classes !== null && !classes.has(e.tokenClass)) return false;
    if (models === undefined) return true;
    return models.some((m) => entryCouldPrice(e, m));
  });
  return [
    ...new Set(
      relevant.flatMap((e) => [
        e.effectiveFrom.getTime(),
        ...(e.effectiveTo === null ? [] : [e.effectiveTo.getTime()]),
      ]),
    ),
  ]
    .filter((at) => at >= since && at <= until)
    .sort((a, b) => a - b);
}

/**
 * The name a price row is compared under when two rows are asked whether they
 * price the same model: the bare family behind a `creator/` prefix, or the
 * name itself when it carries none.
 *
 * `vendor/foo` and `foo` are one identity because {@link resolvePriceEntry}
 * falls back to the family when the id as given matches nothing, so a row
 * under either spelling can price a frame that reports the other. Two rows
 * that normalise to one identity are therefore one model priced twice, and a
 * frame takes whichever spelling it happened to report.
 *
 * The test is the family spelled EXACTLY, never the resolver's prefix rule.
 * Loose is wrong here for the reason {@link syncPriceBook}'s displacement
 * check states: `gpt-4` prefixes `gpt-4o`, and `openai/gpt-4o` and `gpt-4`
 * are two models that merely share a stem.
 */
function resolverIdentity(name: string): string {
  const slash = name.indexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

// ── Store ─────────────────────────────────────────────────────────────────────

type Row = typeof schema.priceEntries.$inferSelect;

function rowToEntry(row: Row): PriceEntry {
  return {
    id: row.id,
    orgId: row.orgId,
    provider: row.provider,
    model: row.model,
    modelAliases: row.modelAliases,
    region: row.region,
    tokenClass: row.tokenClass as PriceTokenClass,
    unit: row.unit as PriceUnit,
    currency: row.currency,
    microsPerMillion: row.microsPerMillion,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    source: row.source as PriceEntry["source"],
  };
}

/**
 * Every entry an organization resolves against: its own rows and the list.
 * Reads through the system connection with an explicit org predicate because
 * the rollup job runs outside a tenant scope.
 */
export async function loadPriceBook(args: {
  orgId: string;
}): Promise<PriceBook> {
  const rows = await withSystemDb((tx) =>
    tx
      .select()
      .from(schema.priceEntries)
      .where(
        or(
          isNull(schema.priceEntries.orgId),
          eq(schema.priceEntries.orgId, args.orgId),
        ),
      ),
  );
  return rows.map(rowToEntry);
}

/**
 * The entries the organization may read — the list and its own negotiated
 * rows, the same set the `org_or_global` policy admits — effective at `at`,
 * ordered for a list: provider, model, class, latest first. The org predicate
 * is in the query as well as the policy, since a stack with RLS enforcement
 * off runs the query under `app.rls_bypass`.
 */
export async function listPriceEntries(args: {
  at: Date;
  orgId: string;
  includeScheduled?: boolean;
}): Promise<PriceEntry[]> {
  const rows = await withTenantDb((tx) =>
    tx
      .select()
      .from(schema.priceEntries)
      .where(
        and(
          or(
            isNull(schema.priceEntries.orgId),
            eq(schema.priceEntries.orgId, args.orgId),
          ),
          or(
            and(
              lte(schema.priceEntries.effectiveFrom, args.at),
              or(
                isNull(schema.priceEntries.effectiveTo),
                gt(schema.priceEntries.effectiveTo, args.at),
              ),
            ),
            args.includeScheduled === true
              ? and(
                  eq(schema.priceEntries.orgId, args.orgId),
                  eq(schema.priceEntries.source, "negotiated"),
                  gt(schema.priceEntries.effectiveFrom, args.at),
                )
              : undefined,
          ),
        ),
      )
      .orderBy(
        schema.priceEntries.provider,
        schema.priceEntries.model,
        schema.priceEntries.tokenClass,
        sql`${schema.priceEntries.effectiveFrom} desc`,
      ),
  );
  return rows.map(rowToEntry);
}

interface PriceBookSyncResult {
  /** Rows written (inserted or updated in place, before they have shipped). */
  written: number;
  /** Rows whose price and names were both unchanged. */
  unchanged: number;
  /**
   * Open rows whose aliases the catalog moved while leaving the rate alone.
   * Updated in place: a name is not a price, so a rename opens no new
   * effective-dated window and reprices nothing.
   */
  renamed: number;
  /**
   * Keys this run left alone because an operator has scheduled a correction
   * for them beyond this run's instant. That row is the authority from its
   * start; the refresh continues for every other key.
   */
  deferred: number;
  /**
   * Open rows closed because another row this sync wrote now prices what
   * they priced: the same model and class under a different provider name,
   * or the same names in a barer spelling. Left open they would be a second
   * row the reader could pick, so one of two prices would apply and neither
   * would be predictable.
   */
  superseded: number;
  /**
   * Open rows closed because the sources no longer emit them: a model a
   * catalog withdrew, or a token class it stopped publishing. Only counted
   * when the caller vouched for the seeds as complete (`retireAbsent`).
   */
  retired: number;
  /**
   * True when the book was still inside its cold-start window, so a seed for
   * a key it had never priced was written effective from
   * {@link COLD_BOOK_EFFECTIVE_FROM} rather than the requested instant,
   * covering the frames that ran before the first sync.
   */
  coldStart: boolean;
  /**
   * True when the book holds at least one row effective from
   * {@link COLD_BOOK_EFFECTIVE_FROM} — one this run floored, or one an
   * earlier run floored and this run left alone.
   *
   * This is the obligation to reprice, read off the book rather than off what
   * this run happened to change. `written` cannot carry it: a caller that
   * backdates rows and then fails to dispatch `cost/price-book.backdated` has
   * already committed them, so its retry reads a correct book, writes
   * nothing, and would ask for nothing — the runs those floored rows can now
   * price would stay blank for ever. While the book is cold this says the
   * request is still owed, whether or not this run wrote a row.
   */
  hasBackdatedRows: boolean;
}

/**
 * Write the list price book from the in-code cards. Idempotent on the row key
 * (provider, model, class, region, effective_from): a re-run with the same
 * `effectiveFrom` and the same terms is a no-op, a re-run with the same
 * `effectiveFrom` and changed terms corrects the row in place only while that
 * instant is still ahead (once it has passed the row may have priced runs,
 * and the change is refused until it is stated as a later window), and a run
 * with a later `effectiveFrom` adds the new rows and closes the previous ones
 * at that instant, so a run priced before the change keeps the entry it
 * used. Negotiated rows are never touched.
 *
 * `retireAbsent` says the seeds are the whole book: every open list row they
 * do not name is closed at `effectiveFrom`. Without it an omitted row stays
 * open, which is right when a catalog was down (its models are absent because
 * the read failed, not because the prices ended) and wrong when every source
 * answered: a model a vendor retired would keep its last price forever, and a
 * class a catalog stopped publishing would keep being priced instead of
 * becoming `estimated`. The caller knows which of the two happened; this
 * function does not, so it is told.
 */
export async function syncPriceBook(args: {
  effectiveFrom: Date;
  seeds?: readonly PriceEntrySeed[];
  retireAbsent?: boolean;
  /**
   * The catalogs that answered completely this run, by id. A row one of them
   * published and no longer names is retired; a row from any other catalog
   * is preserved. `retireAbsent` remains the book-wide statement, used for
   * rows with no catalog recorded.
   *
   * On the run that creates the book this set is also persisted, to
   * `cost.price_book_initializations`, because the cold-start floor needs to
   * know which sources answered at initialization and no later read of the
   * rows can tell: precedence drops the rows of a catalog whose every model
   * lost, leaving it indistinguishable from one that was down.
   */
  completedCatalogs?: readonly string[];
  /** The write instant; a row effective at or before it is not corrected in place. */
  now?: Date;
}): Promise<PriceBookSyncResult> {
  const requested = args.seeds ?? priceEntriesFromRateCards(args.effectiveFrom);
  return withSystemDb(async (tx) => {
    // One list-book writer at a time, whoever the caller is. The hourly job
    // serialises its own executions, but `pnpm billing:price-book-sync
    // --apply` runs this same read-modify-write outside that guard, and two
    // syncs with different instants would each read the same open rows, close
    // them and insert their own successor — the unique key includes
    // `effective_from`, so both inserts land and the key ends with two open
    // prices. Transaction-scoped, released on commit or rollback.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${"price_book:list"}::text, 0))`,
    );
    // The write instant is read AFTER the lock. The lock wait is unbounded:
    // another sync can hold it until the boundary passes, and a clock read
    // before the wait would then pass the boundary check with a stale time
    // and commit a retroactive change. A test injects `now` to pin the
    // instant; a real run reads it here.
    const now = args.now ?? new Date();
    const existing = await tx
      .select()
      .from(schema.priceEntries)
      .where(
        and(
          isNull(schema.priceEntries.orgId),
          inArray(schema.priceEntries.source, ["list", "override"]),
        ),
      );

    // The book's own record of its initialization: the instant, and the
    // catalogs that answered completely at it. One row, `book = 'list'`,
    // written by the sync that created the book (below). It is the authority
    // for both facts; neither can be read back off the rows (see
    // `initialCatalogs`).
    const [initialization] = await tx
      .select()
      .from(schema.priceBookInitializations)
      .where(eq(schema.priceBookInitializations.book, PRICE_BOOK_LIST));

    // A cold book starts before every frame, not at this instant. On a fresh
    // installation the hourly job is the first writer, and any run accepted
    // before its first tick has frames earlier than the instant those rows
    // would otherwise start at — a price effective from the tick could never
    // resolve them, even on a retry, and their cost would stay unrecorded for
    // ever. While the book is cold, a key it has never priced is written
    // effective from {@link COLD_BOOK_EFFECTIVE_FROM}, an instant before any
    // frame Oxagen could have recorded, so every earlier frame prices at the
    // first known rate rather than at nothing.
    //
    // Cold is not "empty". A first sync that ran with a catalog down seeds
    // only the card's models; if that alone ended cold start, the catalog's
    // models would arrive at recovery time when it came back, and calls made
    // before recovery would stay unpriced for ever. So the book stays cold
    // for a fixed window after its first row (below). Until then a newly
    // discovered key is backdated to the floor, which prices only frames of
    // a model the book had never seen; a key the book already prices is
    // handled at the requested instant as always.
    const key = (e: {
      provider: string;
      model: string;
      tokenClass: string;
      region: string | null;
    }) => `${e.provider}|${e.model}|${e.tokenClass}|${e.region ?? ""}`;
    const open = new Map<string, Row>();
    for (const row of existing)
      if (row.effectiveTo === null) open.set(key(row), row);
    // Every key the book has EVER priced, open or closed.
    //
    // The floor is for a key the book has never seen — frames of a model it
    // had no rate for at all. A key whose only row is closed is not that: it
    // was priced, then retired by a complete snapshot. Treating it as unseen
    // (which testing `open` alone did) backdated its return to the floor, the
    // insert collided with the original floor-dated row, and the upsert reset
    // that row's `effective_to` to null — erasing the retirement window and
    // silently repricing every frame inside it. A returning key is a successor
    // at the requested instant, like any other change.
    // Seen WITHOUT the provider dimension. The floor is for a model and class
    // the book has never priced, and a model whose vendor string changed
    // between syncs is not that: it has been priced all along, under the old
    // provider. Keying on the full row key (which carries the provider) called
    // it new, backdated its new-provider row to the floor, and the supersession
    // pass then found the old row starting at that same instant and refused
    // with `price_book_provider_changed_at_same_instant`. That rolled back the
    // whole refresh, every hour, for as long as the book stayed cold.
    const seen = new Set<string>(
      existing.map((r) => `${r.model}|${r.tokenClass}|${r.region ?? ""}`),
    );
    // Cold start is bounded in time, by the book's own creation, and by
    // nothing else. `price_book_initializations.initialized_at` is the record
    // of when that was; the earliest row's `created_at` answers for a book
    // written before that record existed. Once COLD_START_WINDOW_MS has
    // passed since it, the
    // book is established and a new key starts at the requested instant
    // like any other change. The window stays long enough for a catalog
    // that was down at first sync to come back and have its models
    // backdated, which is what cold start is for.
    //
    // Two earlier rules ended it sooner, and both were unsound. "The first
    // row at a real instant ends it" never fired for a book whose rates
    // stayed stable, so a model a catalog added months later was backdated
    // to the floor too, and a rollup retry priced frames from before that
    // model had any known rate. Its repair, "only a complete snapshot may
    // write at a real instant while cold, so a partial run corrects a floor
    // row in place", rewrote a row that every run since the first sync had
    // cited: an OpenRouter rate moving while models.dev was down changed
    // settled costs on rollup retry under the same entry id. A shipped row
    // is never rewritten, at the floor or anywhere else. A repricing while
    // cold is a successor at the requested instant, and that successor is
    // not proof that initialization completed: the window is.
    const bookCreatedAt = existing.reduce<number | null>(
      (earliest, r) =>
        earliest === null || r.createdAt.getTime() < earliest
          ? r.createdAt.getTime()
          : earliest,
      null,
    );
    const initializedAt =
      initialization?.initializedAt.getTime() ?? bookCreatedAt;
    const withinColdWindow =
      initializedAt === null ||
      now.getTime() - initializedAt < COLD_START_WINDOW_MS;
    const coldStart = withinColdWindow;
    // Rows the book already carries at the floor. A floored row is the only
    // kind that prices a run which has already sealed, so its presence — not
    // this run's write count — is what says a repricing is owed. A run that
    // writes nothing because an earlier run already wrote the same floored
    // rows still reports the obligation, which is how a caller whose dispatch
    // failed recovers on its next attempt.
    const flooredBefore = existing.some(
      (r) => r.effectiveFrom.getTime() === COLD_BOOK_EFFECTIVE_FROM.getTime(),
    );
    let flooredHere = false;
    // Which sources answered at initialization, read off the record the first
    // sync wrote. Not off the rows: a catalog that answered then and lost
    // every model to a higher-precedence source contributed no row, so rows
    // cannot tell it from a catalog that was down. Reading them anyway called
    // that catalog incomplete, so its first unique model inside the cold
    // window was floored as a recovery, and the next rollup changed costs on
    // runs that had already settled. Precedence filters the rows; it does not
    // filter the record.
    const initialCatalogs = new Set<string>(
      initialization?.completedCatalogs ?? [],
    );
    // A key is floored as a recovery only on positive evidence that its source
    // was absent at initialization: the record exists, the seed names its
    // catalog, and that catalog is not in the record.
    //
    // Everything else declines to floor, which is the only direction that
    // cannot move a settled cost. A book with no record (one initialized
    // before the record existed) and a seed that names no catalog both leave
    // the source unknown, and flooring on an unknown hands a rate to every
    // frame recorded since the first sync, changing what runs already sealed
    // cost. Declining costs a frame that stays unpriced until a real sync
    // prices its model forward, which a person can see and repair; a repriced
    // settled run is silent. So the unknown case does nothing.
    const recoveredFromIncompleteSource = (seed: PriceEntrySeed): boolean =>
      initialization !== undefined &&
      seed.catalog !== undefined &&
      !initialCatalogs.has(seed.catalog);
    const effectiveFrom = args.effectiveFrom;

    // The boundary is checked HERE, under the lock, against the write
    // instant, not by the caller before its catalog reads. Those reads take
    // up to fifteen seconds and the lock wait is unbounded, so an instant
    // that was ahead when the run began can be behind by the time it writes;
    // the commit would then close old rows retroactively, and frames rolled
    // up in between would cite a window that no longer covers them, with a
    // retry repricing them. Refused, and the transaction rolls back, so the
    // caller re-runs with a later instant.
    //
    // The exemption is per write, not per book. Only a write that lands AT
    // the floor is below every frame; a cold book still writes at the
    // requested instant for a key it has already priced, and closes rows
    // there when it retires or supersedes them, and those writes are as
    // retroactive as any. Exempting the whole cold transaction (which this
    // once did) let a complete refresh that waited on the lock past its
    // boundary close a repriced key's old row in the past. On an established
    // book every write is at the boundary, so it is refused up front,
    // whatever the seeds turn out to need.
    const assertBoundaryAhead = (instant: Date): void => {
      if (instant.getTime() === COLD_BOOK_EFFECTIVE_FROM.getTime()) return;
      if (instant.getTime() > now.getTime()) return;
      throw new HandlerError({
        code: "conflict",
        reason: "price_book_boundary_passed",
        message: `the effective instant ${instant.toISOString()} is not after the write instant ${now.toISOString()}: the refresh took long enough that its boundary has passed, and writing at it would reprice frames already settled; re-run with a later effectiveFrom`,
      });
    };
    if (!coldStart) assertBoundaryAhead(effectiveFrom);
    // While cold, a key the book has never priced is backdated to the floor.
    // A key it has priced, under any provider and whether or not its row is
    // still open, takes the requested instant: a floor row it corrects is
    // closed there and succeeded, never rewritten.
    //
    // An operator override is floored only on the first sync of an empty
    // book. The floor exists for a catalog that was down at first sync and
    // comes back naming models it always priced; the overrides are this
    // installation's own environment, read completely on every run, so an
    // override for a key the book has never priced is not a source
    // recovering, it is terms the operator introduced after an earlier
    // snapshot. Frames for that key since the first sync were priced by the
    // list or left unpriced, and a rollup retry against a floored override
    // would change what they cost. It starts at the requested boundary,
    // like any rate that begins today.
    const emptyBook = bookCreatedAt === null;
    const seeds = coldStart
      ? requested.map((s) => {
          if (seen.has(`${s.model}|${s.tokenClass}|${s.region ?? ""}`))
            return s;
          if (s.source === "override" && !emptyBook) return s;
          // The floor is for a source that was down when the book was
          // written, not for the calendar. A source that answered at
          // initialization has published everything it had since then, so a
          // key it names for the first time today is a model that did not
          // exist before today, and it starts at the requested boundary like
          // any other new rate. Flooring it would hand the new rate to every
          // frame recorded since the first sync.
          if (!emptyBook && !recoveredFromIncompleteSource(s)) return s;
          return { ...s, effectiveFrom: COLD_BOOK_EFFECTIVE_FROM };
        })
      : requested;

    let written = 0;
    let unchanged = 0;
    let renamed = 0;
    let deferred = 0;
    for (const seed of seeds) {
      const current = open.get(key(seed));
      const pricedTheSame =
        current &&
        current.microsPerMillion === seed.microsPerMillion &&
        current.currency === seed.currency &&
        current.unit === seed.unit;
      if (
        pricedTheSame &&
        sameNameList(current.modelAliases, seed.modelAliases)
      ) {
        // Same terms, same names, but a different author: an operator
        // removed an override whose terms matched the catalog exactly, or
        // added one that does. The row must say who owns it now, or the
        // override-retirement pass reads a catalog row as an override and
        // closes it on the next partial run, leaving the model unpriced.
        // Provenance is not a price, so it is stamped in place, not given a
        // new window.
        const source = seed.source ?? "list";
        const catalog = seed.catalog ?? null;
        if (current.source !== source || current.catalog !== catalog) {
          await tx
            .update(schema.priceEntries)
            .set({ source, catalog, updatedAt: new Date() })
            .where(eq(schema.priceEntries.id, current.id));
        }
        unchanged += 1;
        continue;
      }
      // A rename — the catalog republished this model under different names
      // without moving its rate — takes the same path as a repricing: the
      // current row closes at this instant and a successor carries the new
      // names. Aliases decide which frames a row prices, and the rollup
      // resolves each frame with the row's names as stored at the frame's
      // instant, so an alias updated in place on a months-old row would
      // retroactively price old frames under a name they never carried, and
      // an alias withdrawn in place would leave frames that were priceable
      // unpriced on the next recomputation. A successor window keeps every
      // settled frame on the names it was priced with. (Comparing only the
      // rate, which is all this once did, sent an alias-only change down the
      // `unchanged` path and left the row's names stale for ever.)
      if (pricedTheSame) renamed += 1;
      assertBoundaryAhead(seed.effectiveFrom);
      // The upsert below corrects a row at the SAME instant in place. That is
      // right while the instant is still ahead — nothing has been priced
      // against the row — and wrong once it has passed: a same-hour re-run of
      // the CLI with a changed catalog rate or alias would rewrite a row that
      // frames earlier in the hour were priced with, so a rollup retry would
      // apply different terms under the same entry id. A change to a shipped
      // row needs a later window, which is what a later --effective-from is.
      // The floor is no exception: a floor row has priced every frame since
      // the first sync, and a cold book never targets it for a key it has
      // seen, so a conflict there is a defect, not a correction.
      if (
        current &&
        current.effectiveFrom.getTime() === seed.effectiveFrom.getTime() &&
        seed.effectiveFrom.getTime() <= now.getTime()
      )
        throw new HandlerError({
          code: "conflict",
          reason: "price_book_row_already_effective",
          message: `the list price for ${key(seed)} effective from ${seed.effectiveFrom.toISOString()} is already in force and may have priced runs; a change needs a later effectiveFrom`,
        });
      if (
        current &&
        current.effectiveFrom.getTime() > seed.effectiveFrom.getTime()
      ) {
        // The key's open row is a correction an operator SCHEDULED, with an
        // `--effective-from` beyond this run's instant. That row is the
        // authority for this key from its start, and this run has nothing to
        // say about it: writing under it would leave two rows open for one
        // key. Refusing the whole refresh over it (which this once did, as a
        // RangeError) rolled back every other model's update, every hour,
        // until the scheduled instant arrived. The key is left alone and
        // counted, and the rest of the book refreshes.
        deferred += 1;
        continue;
      }
      if (
        current &&
        current.effectiveFrom.getTime() < seed.effectiveFrom.getTime()
      ) {
        await tx
          .update(schema.priceEntries)
          .set({ effectiveTo: seed.effectiveFrom, updatedAt: new Date() })
          .where(eq(schema.priceEntries.id, current.id));
      }
      // Raw params reach the driver untyped: a JS array renders as a value
      // list, so the text[] is spelled as an array constructor
      // (`array[]::text[]` when empty), and the bigint and the instant travel
      // as strings under an explicit cast.
      //
      // `model_aliases` is in the DO UPDATE SET below because the catalog is
      // the authority on a list row's names as well as its rate; omitting it
      // left a re-synced row carrying whichever aliases it was first inserted
      // with.
      const aliases = sql.join(
        seed.modelAliases.map((a) => sql`${a}`),
        sql`, `,
      );
      await tx.execute(sql`
        INSERT INTO ${schema.priceEntries}
          (org_id, provider, model, model_aliases, region, token_class, unit,
           currency, micros_per_million, effective_from, effective_to, source,
           catalog)
        VALUES
          (NULL, ${seed.provider}, ${seed.model}, array[${aliases}]::text[],
           ${seed.region}, ${seed.tokenClass}, ${seed.unit}, ${seed.currency},
           ${seed.microsPerMillion.toString()}::bigint,
           ${seed.effectiveFrom.toISOString()}::timestamptz, NULL,
           ${seed.source ?? "list"}, ${seed.catalog ?? null})
        ON CONFLICT (coalesce(org_id, '${sql.raw(NIL_UUID)}'::uuid),
                     provider, model, token_class, coalesce(region, ''), effective_from)
        DO UPDATE SET
          micros_per_million = EXCLUDED.micros_per_million,
          currency = EXCLUDED.currency,
          unit = EXCLUDED.unit,
          model_aliases = EXCLUDED.model_aliases,
          source = EXCLUDED.source,
          catalog = EXCLUDED.catalog,
          effective_to = NULL,
          updated_at = now()
      `);
      if (!pricedTheSame) written += 1;
      if (seed.effectiveFrom.getTime() === COLD_BOOK_EFFECTIVE_FROM.getTime())
        flooredHere = true;
    }

    // Close any open row this sync has superseded under a DIFFERENT provider
    // name. The row key includes `provider`, so a model whose vendor string
    // changes between syncs — the catalog that won it changed, or a vendor
    // renamed itself — writes a NEW row and leaves the old one open. Two open
    // rows for one model and class is not a duplicate the reader tolerates:
    // `bestMatch` picks by longest name and then by latest `effective_from`,
    // so whichever row happens to win keeps winning, and a price correction
    // can land on the row nothing reads. Superseding by (model, class, region)
    // is what keeps exactly one row open per thing a frame can be priced by.
    const supersededKey = (e: {
      model: string;
      tokenClass: string;
      region: string | null;
    }) => `${e.model}|${e.tokenClass}|${e.region ?? ""}`;
    const writtenKeys = new Map<string, PriceEntrySeed>();
    for (const seed of seeds) writtenKeys.set(supersededKey(seed), seed);
    const closedIds = new Set<string>();
    let superseded = 0;
    for (const row of existing) {
      if (row.effectiveTo !== null) continue;
      const seed = writtenKeys.get(supersededKey(row));
      if (!seed) continue;
      if (seed.provider === row.provider) continue;
      if (row.effectiveFrom.getTime() === seed.effectiveFrom.getTime())
        // The old provider's row starts at this very instant, so it cannot be
        // closed here (`effective_to > effective_from`) and the new row has
        // already landed beside it: two open rows for one model and class
        // with the same start, which `bestMatch` cannot tell apart. That is
        // what the CLI's top-of-hour default produces when a re-run within
        // the hour finds a different vendor string for a model. Refused, and
        // the transaction rolls back, so the operator re-runs with a later
        // --effective-from and the old row closes there.
        throw new HandlerError({
          code: "conflict",
          reason: "price_book_provider_changed_at_same_instant",
          message: `${supersededKey(row)} is already priced from ${seed.effectiveFrom.toISOString()} under provider ${row.provider}; re-pricing it under ${seed.provider} at the same instant would leave two open rows, so use a later effectiveFrom`,
        });
      if (row.effectiveFrom.getTime() > seed.effectiveFrom.getTime()) continue;
      assertBoundaryAhead(seed.effectiveFrom);
      await tx
        .update(schema.priceEntries)
        .set({ effectiveTo: seed.effectiveFrom, updatedAt: new Date() })
        .where(eq(schema.priceEntries.id, row.id));
      closedIds.add(row.id);
      superseded += 1;
    }

    // Retire what the sources no longer emit. A row absent from a complete
    // snapshot is a price that ended: the vendor retired the model, or the
    // catalog stopped publishing that class. Left open it would go on pricing
    // frames at a rate nobody publishes any more, and a class that should
    // now read `estimated` would carry a figure instead. Only on a complete
    // snapshot — a row absent because its catalog was down is preserved, and
    // the caller is the one that knows which happened.
    let retired = 0;
    // Retire per catalog. A row absent from the seeds is a price that ended
    // ONLY if the catalog that published it answered completely this run;
    // a row from a catalog that failed or was held is absent because nobody
    // asked, and closing it would leave its models unpriced until the
    // catalog came back. Deciding this book-wide (retire only when EVERY
    // catalog answered) let a model one catalog withdrew stay priced for as
    // long as any other catalog was down. The operator overrides are a
    // catalog like the rest, one that never fails, so a withdrawn override
    // retires on every run.
    //
    // A row with no catalog recorded (written before the column existed) is
    // treated as belonging to no completed catalog and is retired only on a
    // complete snapshot, as before; the next upsert stamps it.
    const seeded = new Set(seeds.map(key));
    const completed = new Set(args.completedCatalogs ?? []);
    const complete = args.retireAbsent === true;
    for (const row of existing) {
      if (row.effectiveTo !== null || closedIds.has(row.id)) continue;
      if (seeded.has(key(row))) continue;
      const owned =
        row.catalog !== null && row.catalog !== undefined
          ? completed.has(row.catalog)
          : complete;
      if (!owned) continue;
      // A row that starts exactly at this sync's instant, while that
      // instant is still ahead, was scheduled by an earlier run of the same
      // boundary and has priced nothing. The complete snapshot omits it, so
      // it must not take effect: skipping it (as this once did) left it
      // open, and at the boundary it began pricing a model the catalog had
      // withdrawn. It cannot be closed at its own start
      // (`effective_to > effective_from`), so it is deleted, which is safe
      // for exactly that reason: no frame can cite it yet.
      if (
        row.effectiveFrom.getTime() === effectiveFrom.getTime() &&
        effectiveFrom.getTime() > now.getTime()
      ) {
        await tx
          .delete(schema.priceEntries)
          .where(eq(schema.priceEntries.id, row.id));
        closedIds.add(row.id);
        retired += 1;
        continue;
      }
      // A row that starts after this sync cannot close at this instant; it
      // is a later correction this run must not touch. One that starts at
      // an instant already in force is closed normally.
      if (row.effectiveFrom.getTime() >= effectiveFrom.getTime()) continue;
      assertBoundaryAhead(effectiveFrom);
      await tx
        .update(schema.priceEntries)
        .set({ effectiveTo: effectiveFrom, updatedAt: new Date() })
        .where(eq(schema.priceEntries.id, row.id));
      closedIds.add(row.id);
      retired += 1;
    }

    // Close what this run's seeds have displaced BY NAME rather than by key.
    //
    // The two passes above both ask about a row's key. Supersession asks
    // whether a seed prices the same (model, class, region) under another
    // provider; retirement asks whether the catalog that published the row
    // answered and stopped naming it. Neither sees the case where the name
    // itself moved between shapes: an operator adds a bare-family override
    // `foo` while the catalog that published `anthropic/foo` is down, so the
    // merge omits that catalog and its row survives as a preserved absence.
    // `resolvePriceEntry` then resolves the gateway-form id `anthropic/foo`
    // on the direct pass, where only the stale row matches, and never reaches
    // the family pass where the override would win. The override is ignored
    // for as long as the catalog stays down.
    //
    // So a row is closed when a seed written this run answers to the names
    // the row holds. That is not the retirement bug in another shape: a row
    // is not closed for being absent, it is closed because another row now
    // prices exactly what it priced, which is the same reason supersession
    // closes one. Absence alone still preserves the row.
    //
    // A gateway-form row is displaced when a seed answers its bare family
    // (the shape `resolvePriceEntry` falls back to). A bare row is displaced
    // when a seed answers that exact name — including via a prefixed override's
    // default alias that claims the bare family. A seed that names only the
    // gateway form, with no bare alias, still leaves the bare row open, because
    // that row answers ids the seed cannot match.
    //
    // Displacement is per model and region, NOT per token class. A source that
    // wins a model states what that model costs, in every class it prices and
    // by omission in the classes it does not: `mergePublishedPrices` gives one
    // model to one source outright, so no lower source's price for it survives
    // into the seeds. Keyed by class as well as by name, an override for `foo`
    // that stated input and output left the down catalog's `anthropic/foo`
    // cache-read and cache-write rows open, and cached calls went on billing
    // at the stale catalog rate the override had replaced. Those classes
    // become `estimated`, which is the honest answer while the only source
    // that prices them is the one the operator overrode.
    const sourceRank = (source: string | undefined): number =>
      source === "override" ? 1 : 0;
    const nameKey = (region: string | null, name: string) =>
      `${region ?? ""}|${name}`;
    const seedByName = new Map<string, PriceEntrySeed>();
    for (const seed of seeds)
      for (const name of [seed.model, ...seed.modelAliases]) {
        const slot = nameKey(seed.region, name);
        const held = seedByName.get(slot);
        if (
          held === undefined ||
          sourceRank(seed.source) > sourceRank(held.source) ||
          // One slot now holds every class a source priced for the model, so
          // two seeds of equal rank can land on it. The later instant wins, so
          // a displaced row is never closed at the cold-start floor while a
          // seed at this run's boundary displaces it too: closing it at the
          // floor would unprice every frame since the first sync.
          (sourceRank(seed.source) === sourceRank(held.source) &&
            seed.effectiveFrom.getTime() > held.effectiveFrom.getTime())
        )
          seedByName.set(slot, seed);
      }
    // The seed that now answers to a name this row holds, or null. The test
    // is an exact name the seed claims (`seed.model` or an alias), plus — for
    // a gateway-form row — the bare family behind its `creator/` prefix. That
    // is the shape `resolvePriceEntry` falls back to and nothing looser. The
    // resolver's prefix rule is deliberately loose, and loose is wrong here:
    // `gpt-4` prefixes `gpt-4o`, and closing the `openai/gpt-4o` row because
    // some seed prices `gpt-4` would throw away the more specific price for a
    // model that merely shares a stem.
    //
    // A seed that ranks BELOW the row never displaces it, so an operator's
    // override is never closed by a catalog. Above that, a seed outranks
    // every source that did not answer: the merge holds every catalog below a
    // failed one, so whatever wrote this run sits higher in precedence than
    // whatever did not.
    const displacedBy = (row: Row): PriceEntrySeed | null => {
      for (const name of [row.model, ...row.modelAliases]) {
        const slash = name.indexOf("/");
        if (slash < 0) {
          // Bare spelling on the row: only a prefixed seed that claims this
          // exact name (as model or alias) displaces it. Bare-to-bare is the
          // earlier supersession pass's job; closing every class of a bare
          // row because another bare seed priced one class would over-claim.
          const seed = seedByName.get(nameKey(row.region, name));
          if (seed === undefined) continue;
          if (sourceRank(seed.source) < sourceRank(row.source)) continue;
          if (!seed.model.includes("/")) continue;
          return seed;
        }
        const seed = seedByName.get(nameKey(row.region, name.slice(slash + 1)));
        if (seed === undefined) continue;
        if (sourceRank(seed.source) < sourceRank(row.source)) continue;
        return seed;
      }
      return null;
    };
    for (const row of existing) {
      if (row.effectiveTo !== null || closedIds.has(row.id)) continue;
      // A key this run seeded is the seed loop's business. Both spellings
      // can be wanted at once, when one catalog names a model bare and
      // another names it gateway-form and the merge emitted both, and
      // closing a row the run just wrote would leave that spelling
      // unpriced.
      if (seeded.has(key(row))) continue;
      const seed = displacedBy(row);
      if (seed === null) continue;
      if (row.effectiveFrom.getTime() === seed.effectiveFrom.getTime()) {
        // The row starts at this run's own instant, so it cannot be closed
        // there (`effective_to > effective_from`). While that instant is
        // still ahead it has priced nothing and is deleted, as the
        // retirement pass deletes a scheduled row a complete snapshot omits.
        // At an instant already in force it is left alone. Only the floor
        // reaches that case, the boundary check having refused every other
        // instant, and deleting a floor row would unprice every frame since
        // the first sync, which is worse than the stale row it replaces.
        if (seed.effectiveFrom.getTime() <= now.getTime()) continue;
        await tx
          .delete(schema.priceEntries)
          .where(eq(schema.priceEntries.id, row.id));
        closedIds.add(row.id);
        superseded += 1;
        continue;
      }
      // A row that starts after this run is a later correction, not
      // something this run may close.
      if (row.effectiveFrom.getTime() > seed.effectiveFrom.getTime()) continue;
      assertBoundaryAhead(seed.effectiveFrom);
      await tx
        .update(schema.priceEntries)
        .set({ effectiveTo: seed.effectiveFrom, updatedAt: new Date() })
        .where(eq(schema.priceEntries.id, row.id));
      closedIds.add(row.id);
      superseded += 1;
    }

    // Record the initialization, in the transaction that performed it. Only
    // the run that created the book writes this, and only if it created rows:
    // a run that wrote nothing left no book, so the next run is still the
    // first. `completedCatalogs` is what the caller vouched for on this run,
    // which is the set no later read can reconstruct, because precedence
    // filters the rows and a catalog that lost every model leaves none.
    //
    // `onConflictDoNothing` so a concurrent first sync cannot overwrite the
    // record with its own view. The advisory lock above already serialises
    // list-book writers, and the primary key is the second answer if the lock
    // ever moves.
    if (emptyBook && written > 0)
      await tx
        .insert(schema.priceBookInitializations)
        .values({
          book: PRICE_BOOK_LIST,
          initializedAt: now,
          completedCatalogs: [...new Set(args.completedCatalogs ?? [])],
        })
        .onConflictDoNothing();

    return {
      written,
      unchanged,
      renamed,
      deferred,
      superseded,
      retired,
      coldStart,
      hasBackdatedRows: flooredBefore || flooredHere,
    };
  });
}

/**
 * The unit a token class is metered in. A negotiated rate card names the class
 * ("output"), never the unit, so the write derives the unit rather than asking
 * a customer for it; the list rows ./pricing.ts seeds carry the same pairing.
 */
export const PRICE_UNIT_BY_TOKEN_CLASS: Record<PriceTokenClass, PriceUnit> = {
  input_uncached: "token",
  cache_read: "token",
  cache_write_5m: "token",
  cache_write_1h: "token",
  output: "token",
  reasoning: "token",
  embedding_input: "token",
  server_tool_request: "request",
  rerank: "request",
  image: "image",
  video_second: "second",
};

/** Two name lists are the same list when they name the same things, in any order. */
function sameNameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedB = [...b].sort();
  return [...a].sort().every((name, i) => name === sortedB[i]);
}

/** The row key the unique index arbitrates on, for a message a person can act on. */
function entryKey(e: {
  provider: string;
  model: string;
  tokenClass: string;
  region: string | null;
}): string {
  return `${e.provider}|${e.model}|${e.tokenClass}|${e.region ?? ""}`;
}

/** The (provider, model, token class, region) one negotiated row prices. */
export interface NegotiatedPriceKey {
  orgId: string;
  provider: string;
  model: string;
  tokenClass: PriceTokenClass;
  /** Null (the default) is the region-agnostic row. */
  region?: string | null;
}

export interface SetNegotiatedPriceEntryArgs extends NegotiatedPriceKey {
  /** Extra names the frame's model id may arrive under; replaces the stored list. */
  modelAliases?: readonly string[];
  /** Integer micro-USD per one million units. Use {@link usdPerMillionToMicros}. */
  microsPerMillion: bigint;
  /** ISO 4217; the store records micro-USD, so anything but USD is a different store. */
  currency?: string;
  /** Derived from the token class when omitted. */
  unit?: PriceUnit;
  /**
   * The instant the rate starts applying. Omitted, it is the write instant —
   * sampled under the locks, so a wait on another writer cannot leave the
   * rate starting before the write that recorded it.
   */
  effectiveFrom?: Date;
  /**
   * The write instant. A row whose `effectiveFrom` is at or before it has
   * shipped and is refused a non-identical in-place correction. Injected by
   * tests; omitted, it is read AFTER the advisory locks, because the lock
   * wait is unbounded and a clock read before it can be stale by the time
   * the check runs.
   */
  now?: Date;
}

/** What one negotiated write changed. */
export interface NegotiatedPriceWrite {
  /** The row now in effect for the key. */
  entry: PriceEntry;
  /**
   * The row this write closed at `effectiveFrom`, or null when nothing was
   * open for the key or the write corrected a row that had not shipped yet.
   */
  closed: PriceEntry | null;
}

/**
 * The organization's rows for one key, newest first. Runs in the tenant's
 * scope with the org written into the predicate as well as the policy, since a
 * stack with RLS enforcement off runs the query under `app.rls_bypass`.
 *
 * `anyProvider` widens the read to every provider string for the (model,
 * class, region): the resolver never reads `provider`, so a second provider's
 * row for the same model is a second candidate, not a different price.
 */
async function readKeyRows(
  tx: Tx,
  key: NegotiatedPriceKey,
  options: { includeList: boolean; anyProvider?: boolean; anyModel?: boolean },
): Promise<Row[]> {
  const region = key.region ?? null;
  const rows = await tx
    .select()
    .from(schema.priceEntries)
    .where(
      and(
        options.includeList
          ? or(
              isNull(schema.priceEntries.orgId),
              eq(schema.priceEntries.orgId, key.orgId),
            )
          : eq(schema.priceEntries.orgId, key.orgId),
        ...(options.anyProvider === true
          ? []
          : [eq(schema.priceEntries.provider, key.provider)]),
        ...(options.anyModel === true
          ? []
          : [eq(schema.priceEntries.model, key.model)]),
        eq(schema.priceEntries.tokenClass, key.tokenClass),
        region === null
          ? isNull(schema.priceEntries.region)
          : eq(schema.priceEntries.region, region),
      ),
    );
  return [...rows].sort(
    (a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime(),
  );
}

/**
 * Serialise every negotiated write and removal for one organization's (model,
 * class, region) — the set of rows the resolver can pick between for a frame.
 *
 * Without this two writes for one key read the same open row before either
 * commits, each closes it and inserts its own open row, and the key ends with
 * two open windows — after which a removal closes only the newest and the
 * older negotiated rate quietly stays in force instead of falling back to
 * list pricing. A removal that overlaps a write is the same race with a
 * different loser: both read the old state, the setter inserts a new open row
 * despite the removal, or the remover closes the old row and reports success
 * while the new rate stands. The read-then-write is not atomic on its own and
 * no constraint forbids a second open window, so the lock is what serialises
 * them. Transaction-scoped: released by the commit or the rollback, never
 * left held.
 *
 * Keyed WITHOUT the provider string: `resolvePriceEntry` never reads it, so
 * two providers' rows for one model are two candidates for the same frame and
 * must not be written concurrently either. Keyed WITH the org, so two
 * organisations correcting the same model never wait on each other.
 *
 * One lock per IDENTITY the row answers to, meaning
 * {@link resolverIdentity} over its model and every alias, taken in sorted
 * order so two writers never wait on each other's second lock. The resolver
 * treats a model, its aliases and
 * the bare family behind a `creator/` prefix as one identity, so a write for
 * `vendor/foo` and a write for `foo` are writes to the same thing and must
 * serialise; keyed on the model string alone they would not, and neither
 * would a write keyed on the raw names when the two spellings share no name.
 */
/**
 * The coarse lock every negotiated write in an org and class takes before it
 * resolves which names it will carry. See the caller for the deadlock it
 * prevents. Transaction-scoped, like the per-name locks.
 */
async function lockNegotiatedClass(
  tx: Tx,
  key: NegotiatedPriceKey,
): Promise<void> {
  const region = key.region ?? null;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`price_entry_class:${key.orgId}:${key.tokenClass}|${region ?? ""}`}::text, 0))`,
  );
}

async function lockNegotiatedKey(
  tx: Tx,
  key: NegotiatedPriceKey,
  names: readonly string[] = [key.model],
): Promise<void> {
  const region = key.region ?? null;
  const identities = new Set(names.map(resolverIdentity));
  for (const name of [...identities].sort()) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`price_entry:${key.orgId}:${name}|${key.tokenClass}|${region ?? ""}`}::text, 0))`,
    );
  }
}

/**
 * Write one organization's negotiated rate for a (provider, model, token
 * class, region), effective from `effectiveFrom`.
 *
 * The row key is the unique index's: a re-run with the same `effectiveFrom`
 * and the same terms is a no-op, and a re-run with the same `effectiveFrom`
 * and different terms corrects the row in place ONLY while that instant is
 * still in the future — a row whose window has begun has priced frames, and
 * `priceEntryIds` on those cost records name it, so changing its terms would
 * change what a settled run cost the next time its rollup is recomputed. A
 * correction to a shipped row is refused; the caller states a later
 * `effectiveFrom` instead. A run with a LATER `effectiveFrom` never touches
 * the shipped row — it closes it at the new instant and inserts a new one, so
 * a run priced before the change keeps the entry it was priced with and a
 * recomputed cost record still resolves that id. A backdated write under an
 * open row is refused for the same reason {@link syncPriceBook} refuses one:
 * it would leave two rows open for one key, and it would reprice runs that
 * already settled.
 *
 * Identity is the model, its aliases, the bare family behind a `creator/`
 * prefix AND a point-in-time stamp, because that is how the resolver reads a
 * row: an organization that has negotiated `foo` and then negotiates
 * `vendor/foo` or `foo-0613` as a model would hold two live rows for one
 * thing, and a frame would be priced by whichever spelling it happened to
 * report. A write whose identities overlap a live row under a different model
 * is refused until that rate is ended. Two models that merely share a stem
 * stay distinct: the family is spelled exactly and the suffix rule is
 * {@link isSameModelIdentity}, so `openai/gpt-4o` and `gpt-4` are two rates,
 * and so are `gpt-5` and `gpt-5.2`.
 *
 * `source` is always `negotiated` and `org_id` is always the organization's:
 * `price_entries_org_source_check` is `(source = 'list') = (org_id IS NULL)`,
 * so a negotiated row with a null org is refused by the table itself.
 *
 * Unlike {@link syncPriceBook}, which is the platform's own write over every
 * organization's list rows and therefore runs on `withSystemDb`, this is a
 * tenant write: it runs in the caller's scope through `withTenantDb`, with the
 * org in the predicate as well as in the RLS policy.
 */
export async function setNegotiatedPriceEntry(
  args: SetNegotiatedPriceEntryArgs,
  transaction?: Tx,
): Promise<NegotiatedPriceWrite> {
  if (args.microsPerMillion < 0n)
    throw new RangeError(`a price must be a non-negative integer of micros`);
  const region = args.region ?? null;
  const unit = args.unit ?? PRICE_UNIT_BY_TOKEN_CLASS[args.tokenClass];
  const currency = args.currency ?? "USD";
  // `undefined` and `[]` are different instructions and stay different all the
  // way to the SQL. Omission preserves whatever aliases the row already
  // carries — every caller that corrects a price without retyping the alias
  // list depends on that — while an explicit empty array clears them.
  const modelAliases = args.modelAliases;
  const key = entryKey({ ...args, region });
  const write = async (tx: Tx): Promise<NegotiatedPriceWrite> => {
    // The names this write will end up carrying, resolved BEFORE the locks
    // and the overlap check, because both are about names. With the list
    // omitted, the write inherits the aliases of the key's latest row (open
    // or ended); resolving that only at insert time let the overlap check run
    // on the bare model name, so a rate re-established after a gap could
    // restore an alias another live row had legitimately taken up in the
    // meantime, and two live rows then answered for one resolver identity.
    //
    // The key's own chain is read under its model-name lock first, which is
    // enough to make the inherited list stable; then every name is locked.
    //
    // Two phases of locking cannot be ordered against each other: a write for
    // `foo` (alias `bar`) and one for `bar` (alias `foo`) each took their own
    // model lock first and then waited on the other's, and Postgres broke the
    // deadlock by aborting one, where the intended answer was an alias
    // conflict. So a single coarse lock on the class goes first. It
    // serialises the resolve-then-lock step for every negotiated write in
    // this org and class, which makes the per-name locks below always be
    // taken by one writer at a time, in one sorted order.
    await lockNegotiatedClass(tx, args);
    const ownChain = await readKeyRows(tx, args, { includeList: false });
    const effectiveAliases = modelAliases ?? ownChain[0]?.modelAliases ?? [];
    const names = new Set([args.model, ...effectiveAliases]);
    // The identities those names answer to, which is what the locks and the
    // overlap check below are both about. A name and its bare family are one
    // identity ({@link resolverIdentity}), so a row spelled `vendor/foo` and
    // a row spelled `foo` collide even though they share no name.
    const identities = new Set([...names].map(resolverIdentity));
    await lockNegotiatedKey(tx, args, [...names]);
    // The write instant is read here, under the locks, and not before
    // `withTenantDb`. The lock wait is unbounded: another negotiated write
    // can hold the class lock until a scheduled `effectiveFrom` has passed,
    // and a clock read before the wait then let a correction to the row at
    // that instant pass the shipped-window check and change, in place, the
    // terms of a row that priced frames during the wait.
    const now = args.now ?? new Date();
    const from = args.effectiveFrom ?? now;
    const everyModel = await readKeyRows(tx, args, {
      includeList: false,
      anyProvider: true,
      anyModel: true,
    });
    const live = (r: Row) =>
      r.effectiveTo === null || r.effectiveTo.getTime() > from.getTime();

    // One identity per negotiated class. The resolver matches a frame against
    // a row's model AND its aliases, so a live row under a different model
    // string that answers to one of this write's identities is the same thing
    // priced twice, and a frame would take whichever spelling it reported.
    //
    // The comparison is on identities rather than on the raw names, because
    // the resolver reaches a row two ways. `vendor/foo` and `foo` share no
    // name, but a frame reporting `vendor/foo` resolves the `foo` row on the
    // family fallback, so an organization holding both rows prices one model
    // at two contracted rates, chosen by the spelling the frame happened to
    // carry. Comparing the spellings as written let the second row in.
    //
    // Two identities are compared with {@link isSameModelIdentity}, the same
    // test {@link resolvePriceEntry} picks rows with, and in BOTH directions.
    // Set membership alone compared the identities as strings, so an
    // organization holding a negotiated `gpt-4` row was still allowed a second
    // row for `gpt-4-0613`. The resolver treats a point-in-time stamp as the
    // same product, so it then answers a frame spelled `gpt-4-0613` with the
    // stamped row (the longer match) and a frame spelled `gpt-4` with the
    // family row: one model at two contracted rates, picked by the spelling
    // the harness recorded. Both directions are needed because either row can
    // be the stamped one — the stamped row may already be live when the bare
    // family is written.
    const sameIdentity = (other: string) => {
      for (const mine of identities)
        if (
          isSameModelIdentity(mine, other) ||
          isSameModelIdentity(other, mine)
        )
          return true;
      return false;
    };
    const overlapping = everyModel.find(
      (r) =>
        r.model !== args.model &&
        live(r) &&
        [r.model, ...r.modelAliases].some((name) =>
          sameIdentity(resolverIdentity(name)),
        ),
    );
    if (overlapping)
      throw new HandlerError({
        code: "conflict",
        reason: "price_entry_alias_conflict",
        message: `${args.model} ${args.tokenClass} resolves to the same model as the negotiated row for ${overlapping.model} (aliases ${JSON.stringify(overlapping.modelAliases)}, effective from ${overlapping.effectiveFrom.toISOString()}); the resolver treats a model, its aliases, the bare family behind a \`creator/\` prefix and a point-in-time stamp such as \`-0613\` as one identity, so end that rate before setting this one`,
      });
    const everyProvider = everyModel.filter((r) => r.model === args.model);

    // One provider per negotiated model and class. The row key carries the
    // provider string, so nothing in the table stops an organization holding
    // `anthropic / claude-sonnet-5 / output` AND `openrouter / claude-sonnet-5
    // / output` open at once — but `resolvePriceEntry` never receives or
    // filters on a frame's provider (a frame may not even carry one), so both
    // rows would match every call and the newer would win globally, applying
    // one provider's commercial terms to traffic billed by the other. Rather
    // than silently pick, the second provider is refused until the first is
    // ended: a rate that will not apply as stated is worse than one refused.
    const otherProvider = everyProvider.find(
      (r) =>
        r.provider !== args.provider &&
        (r.effectiveTo === null || r.effectiveTo.getTime() > from.getTime()),
    );
    if (otherProvider)
      throw new HandlerError({
        code: "conflict",
        reason: "price_entry_provider_conflict",
        message: `${args.model} ${args.tokenClass} is already negotiated under provider ${otherProvider.provider} (effective from ${otherProvider.effectiveFrom.toISOString()}); the resolver does not distinguish providers for one model, so end that rate before setting one under ${args.provider}`,
      });
    const rows = everyProvider.filter((r) => r.provider === args.provider);

    // A correction is always a later row. A row already effective from an
    // instant after this one — open or since superseded — means this write
    // would either leave two rows open for the key or reprice a window that
    // has already settled.
    const later = rows.filter(
      (r) => r.effectiveFrom.getTime() > from.getTime(),
    );
    const earliestLater = later[later.length - 1];
    if (earliestLater)
      // A refusal the caller can act on (pick a later instant), not a server
      // fault: a bare RangeError reaches the API and MCP surfaces as an
      // unclassified 500 and the app as `kernel_failure`, because every seam
      // classifies on `code` and a bare Error carries none.
      throw new HandlerError({
        code: "conflict",
        reason: "price_entry_superseded",
        message: `a negotiated price for ${key} is already effective from ${earliestLater.effectiveFrom.toISOString()}; a correction must not start earlier`,
      });

    // The upsert clears `effective_to`, so a row at exactly this instant that
    // has already been closed would be reopened and the window between its
    // close and now would silently become negotiated again.
    const atInstant = rows.find(
      (r) => r.effectiveFrom.getTime() === from.getTime(),
    );
    if (atInstant && atInstant.effectiveTo !== null)
      throw new HandlerError({
        code: "conflict",
        reason: "price_entry_already_ended",
        message: `the negotiated price for ${key} effective from ${from.toISOString()} was ended at ${atInstant.effectiveTo.toISOString()}; re-establish it as a new row with a later effectiveFrom`,
      });

    // A row whose window has begun has priced frames, and their cost records
    // name it in `priceEntryIds`. Correcting it in place would change what a
    // settled run cost the next time its rollup is recomputed, and the record
    // would still cite the same entry id as proof. The same terms again is a
    // harmless no-op (a retry); different terms need a later window.
    const identical =
      atInstant !== undefined &&
      atInstant.microsPerMillion === args.microsPerMillion &&
      atInstant.currency === currency &&
      atInstant.unit === unit &&
      (modelAliases === undefined ||
        sameNameList(atInstant.modelAliases, modelAliases));
    if (atInstant && !identical && from.getTime() <= now.getTime())
      throw new HandlerError({
        code: "conflict",
        reason: "price_entry_already_effective",
        message: `the negotiated price for ${key} effective from ${from.toISOString()} is already in force and has priced runs; state the correction as a new row with a later effectiveFrom`,
      });

    // A FIRST write for a key is guarded the same way: with no row at the
    // instant there is nothing to compare, but a start in the past would win
    // over the list price for every historical frame, and a rollup retry
    // would change settled costs while their records still cite the list
    // entries they were priced with. Refused beyond a short grace — the
    // instant a caller took before its request, minus request latency and
    // clock skew, is "now", not backdating; a start hours old is.
    if (
      atInstant === undefined &&
      from.getTime() < now.getTime() - PAST_START_GRACE_MS
    )
      throw new HandlerError({
        code: "conflict",
        reason: "price_entry_starts_in_past",
        message: `a negotiated price for ${key} cannot start at ${from.toISOString()}, before the write instant ${now.toISOString()}: frames already priced would be repriced on their next rollup; start it now or later`,
      });

    const open = rows.find((r) => r.effectiveTo === null) ?? null;
    let closed: Row | null = null;
    if (open && open.effectiveFrom.getTime() < from.getTime()) {
      await tx
        .update(schema.priceEntries)
        .set({ effectiveTo: from, updatedAt: new Date() })
        .where(eq(schema.priceEntries.id, open.id));
      closed = { ...open, effectiveTo: from };
    }

    // Raw params reach the driver untyped: a JS array renders as a value
    // list, so the text[] is spelled as an array constructor
    // (`array[]::text[]` when empty), and the bigint and the instant travel
    // as strings under an explicit cast. The ON CONFLICT target restates
    // `price_entries_key_idx`'s own expressions, or Postgres finds no index
    // to arbitrate on.
    // Resolved above, before the locks and the overlap check.
    const inherited = effectiveAliases;
    const aliases = sql.join(
      inherited.map((a) => sql`${a}`),
      sql`, `,
    );
    const aliasAssignment =
      modelAliases === undefined
        ? sql`model_aliases = ${schema.priceEntries}.model_aliases`
        : sql`model_aliases = EXCLUDED.model_aliases`;
    await tx.execute(sql`
      INSERT INTO ${schema.priceEntries}
        (org_id, provider, model, model_aliases, region, token_class, unit,
         currency, micros_per_million, effective_from, effective_to, source)
      VALUES
        (${args.orgId}::uuid, ${args.provider}, ${args.model},
         array[${aliases}]::text[], ${region}, ${args.tokenClass}, ${unit},
         ${currency}, ${args.microsPerMillion.toString()}::bigint,
         ${from.toISOString()}::timestamptz, NULL, 'negotiated')
      ON CONFLICT (coalesce(org_id, '${sql.raw(NIL_UUID)}'::uuid),
                   provider, model, token_class, coalesce(region, ''), effective_from)
      DO UPDATE SET
        micros_per_million = EXCLUDED.micros_per_million,
        currency = EXCLUDED.currency,
        unit = EXCLUDED.unit,
        ${aliasAssignment},
        effective_to = NULL,
        updated_at = now()
    `);

    const after = await readKeyRows(tx, args, { includeList: false });
    const stored = after.find(
      (r) => r.effectiveFrom.getTime() === from.getTime(),
    );
    if (!stored)
      throw new Error(
        `negotiated price for ${key} was not readable after the write`,
      );
    return {
      entry: rowToEntry(stored),
      closed: closed === null ? null : rowToEntry(closed),
    };
  };
  return transaction ? write(transaction) : withTenantDb(write);
}

/** Commit a model's classes together. Readers see the old card or the new card. */
export async function setNegotiatedPriceCard(
  args: Omit<
    SetNegotiatedPriceEntryArgs,
    "tokenClass" | "microsPerMillion" | "unit"
  > & {
    rates: { tokenClass: PriceTokenClass; microsPerMillion: bigint }[];
  },
): Promise<NegotiatedPriceWrite[]> {
  const classes = args.rates.map((rate) => rate.tokenClass);
  if (classes.length === 0 || new Set(classes).size !== classes.length) {
    throw new RangeError("A price card needs distinct token classes");
  }
  return withTenantDb(async (tx) => {
    // Every card locks classes in the same order before writing any row.
    for (const tokenClass of [...classes].sort()) {
      await lockNegotiatedClass(tx, { ...args, tokenClass });
    }
    const now = args.now ?? new Date();
    const effectiveFrom = args.effectiveFrom ?? now;
    const writes: NegotiatedPriceWrite[] = [];
    for (const rate of args.rates) {
      writes.push(
        await setNegotiatedPriceEntry(
          { ...args, ...rate, now, effectiveFrom },
          tx,
        ),
      );
    }
    return writes;
  });
}

/** What ending a negotiated rate at an instant did. */
export interface NegotiatedPriceClose {
  /**
   * The instant the rate ended: the caller's `at`, or the write instant read
   * under the locks when the caller gave none.
   */
  at: Date;
  /**
   * The row that was in effect at `at`, now ending there; null when the
   * organization had no rate in effect at that instant.
   */
  closed: PriceEntry | null;
  /**
   * Corrections scheduled to start after `at` that this call cancelled. They
   * had not begun, so no run was ever priced against them, and they are
   * removed rather than closed: a row cannot end before it starts.
   */
  cancelled: PriceEntry[];
}

/**
 * End an organization's negotiated rate for one key at `at`, so every frame
 * from that instant on resolves to the list price again.
 *
 * The rate is the whole effective-dated chain for the key, not one row. The
 * row in effect at `at` is closed there — `effective_to = at` — and never
 * deleted: a cost record priced before `at` still names the entry, and the
 * rollup can still read it. A row already closed at a later instant is
 * shortened to `at` for the same reason. A correction scheduled to start
 * AFTER `at` would re-establish the rate the caller just ended, so it is
 * cancelled: removed if it has not yet begun (nothing was priced against it,
 * so nothing is lost), refused if it has — ending a rate at an instant before
 * a window that has already shipped would reprice settled runs, which is the
 * same refusal a backdated write meets. Re-ending a key the organization has
 * already ended is a no-op that answers a null close, so a retry is safe.
 *
 * Takes the same per-key lock the write takes: a removal that overlaps a
 * write is otherwise a race one of them loses silently.
 *
 * A key with no negotiated row for this organization answers the same null
 * close, whatever else prices it. A list row is not an organization's to
 * change and is never touched, and a null close claims nothing was. This
 * once refused such a key (`price_entry_not_negotiated`), which broke the
 * retry: a cancelled scheduled row is deleted, so a call that cancelled the
 * only row succeeded and its retry, finding nothing, threw. The contract and
 * the MCP tool promise an idempotent retry, so the empty case is the no-op.
 */
export async function closeNegotiatedPriceEntry(args: {
  orgId: string;
  provider: string;
  model: string;
  tokenClass: PriceTokenClass;
  region?: string | null;
  /**
   * The instant the negotiated rate stops applying. Omitted, it is the write
   * instant, sampled under the locks: a cutoff fixed before the lock wait
   * would be in the past by the time the wait ends, and the shipped-window
   * guard below would then refuse an end nobody backdated.
   */
  at?: Date;
  /** Cancel only this future row and restore its predecessor window. */
  scheduledEntryId?: string;
  /**
   * The write instant, which decides whether a scheduled row has begun.
   * Injected by tests; omitted, it is read after the locks, for the reason
   * `at` is.
   */
  now?: Date;
}): Promise<NegotiatedPriceClose> {
  const region = args.region ?? null;
  const key = entryKey({ ...args, region });

  return withTenantDb(async (tx) => {
    // The same two locks a write takes, in the same order, so a close and a
    // write for one key never interleave and never invert.
    await lockNegotiatedClass(tx, args);
    await lockNegotiatedKey(tx, args);
    // Read under the locks, like the setter's: a removal that waited on a
    // write can otherwise carry a `now` from before the wait, pass the
    // shipped-window guard, and close the row behind a frame the rollup
    // priced against it during the wait.
    const now = args.now ?? new Date();
    const atInstant = args.at ?? now;
    // The organization's rows only. The list rows used to be read here so a
    // key priced only by the list could be refused; that refusal is gone (see
    // above), so there is nothing to read them for.
    const rows = await readKeyRows(tx, args, { includeList: false });
    const own = rows.filter((r) => r.source !== "list");
    // Nothing of this organization's to end: never negotiated, or a
    // scheduled row an earlier call already cancelled. The same answer for
    // both, because the cancellation left no row to tell them apart, and a
    // retry of a lost response must succeed.
    if (own.length === 0) return { at: atInstant, closed: null, cancelled: [] };

    if (args.scheduledEntryId !== undefined) {
      const selected = own.find((row) => row.id === args.scheduledEntryId);
      if (!selected) return { at: now, closed: null, cancelled: [] };
      if (selected.effectiveFrom.getTime() <= now.getTime())
        throw new HandlerError({
          code: "conflict",
          reason: "price_entry_already_started",
          message:
            "This rate has started. Refresh the price book and end the active rate instead.",
        });
      const predecessor = own.find(
        (row) =>
          row.effectiveTo?.getTime() === selected.effectiveFrom.getTime(),
      );
      if (predecessor) {
        const everyModel = await readKeyRows(tx, args, {
          includeList: false,
          anyProvider: true,
          anyModel: true,
        });
        const names = [predecessor.model, ...predecessor.modelAliases].map(
          resolverIdentity,
        );
        const conflict = everyModel.find(
          (row) =>
            row.id !== selected.id &&
            row.id !== predecessor.id &&
            (selected.effectiveTo === null ||
              row.effectiveFrom < selected.effectiveTo) &&
            (row.effectiveTo === null ||
              row.effectiveTo > selected.effectiveFrom) &&
            [row.model, ...row.modelAliases]
              .map(resolverIdentity)
              .some((other) =>
                names.some(
                  (name) =>
                    isSameModelIdentity(name, other) ||
                    isSameModelIdentity(other, name),
                ),
              ),
        );
        if (conflict)
          throw new HandlerError({
            code: "conflict",
            reason: "price_entry_alias_conflict",
            message:
              "Cancelling this rate would extend its predecessor into another negotiated rate. End the conflicting rate first.",
          });
        await tx
          .update(schema.priceEntries)
          .set({ effectiveTo: selected.effectiveTo, updatedAt: now })
          .where(eq(schema.priceEntries.id, predecessor.id));
      }
      await tx
        .delete(schema.priceEntries)
        .where(eq(schema.priceEntries.id, selected.id));
      return { at: now, closed: null, cancelled: [rowToEntry(selected)] };
    }

    const at = atInstant.getTime();
    // The row in effect at `at`, not the open one: after a future-dated
    // correction the current row is already closed at that future instant and
    // the scheduled row is the only open one, so "the open row" is the wrong
    // row and ending the visible rate becomes impossible.
    // Strictly before `at`: a row that starts AT `at` has no window to close
    // there, so it is treated with the scheduled rows below — cancelled if it
    // has not begun (the current row already ends at that instant, and list
    // pricing from the transition on is exactly what was asked for), refused
    // if it has.
    const active =
      own.find(
        (r) =>
          r.effectiveFrom.getTime() < at &&
          (r.effectiveTo === null || r.effectiveTo.getTime() > at),
      ) ?? null;

    const scheduled = own.filter((r) => r.effectiveFrom.getTime() >= at);
    const begun = scheduled.find(
      (r) => r.effectiveFrom.getTime() <= now.getTime(),
    );
    if (begun)
      throw new HandlerError({
        code: "conflict",
        reason: "price_entry_ends_before_it_starts",
        message: `the negotiated price for ${key} effective from ${begun.effectiveFrom.toISOString()} is already in force; it cannot end at ${atInstant.toISOString()}, before it starts — end it at or after that instant`,
      });

    if (active === null && scheduled.length === 0)
      return { at: atInstant, closed: null, cancelled: [] };

    // A cutoff in the past shortens a window that has already priced runs:
    // every frame between `at` and now would resolve to the list price on a
    // rollup retry while its cost record still cites the negotiated entry.
    // The same refusal the setter gives an in-place correction to a shipped
    // row. `at` at or after the write instant shortens nothing that shipped.
    if (active && at < now.getTime())
      throw new HandlerError({
        code: "conflict",
        reason: "price_entry_window_shipped",
        message: `the negotiated price for ${key} has priced runs between ${atInstant.toISOString()} and ${now.toISOString()}; a rate cannot be ended in the past — end it now or at a later instant`,
      });

    if (active) {
      await tx
        .update(schema.priceEntries)
        .set({ effectiveTo: atInstant, updatedAt: new Date() })
        .where(eq(schema.priceEntries.id, active.id));
    }
    if (scheduled.length > 0) {
      await tx.delete(schema.priceEntries).where(
        inArray(
          schema.priceEntries.id,
          scheduled.map((r) => r.id),
        ),
      );
    }
    return {
      at: atInstant,
      closed:
        active === null
          ? null
          : rowToEntry({ ...active, effectiveTo: atInstant }),
      cancelled: scheduled.map(rowToEntry),
    };
  });
}
