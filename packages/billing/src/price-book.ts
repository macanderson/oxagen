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
import type { PriceTokenClass, PriceUnit } from "@oxagen/database/schema";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
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
  const next = new Date(now.getTime());
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next;
}

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
export type PriceEntrySeed = Omit<PriceEntry, "id" | "orgId" | "source">;

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

/** The longest of an entry's names that prefixes `modelId`, or null. */
function matchLength(entry: PriceEntry, modelId: string): number | null {
  let best: number | null = null;
  for (const name of [entry.model, ...entry.modelAliases]) {
    if (modelId === name || modelId.startsWith(name)) {
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
  const live = book.filter(
    (e) => e.tokenClass === args.tokenClass && effectiveAt(e, args.at),
  );
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
          lte(schema.priceEntries.effectiveFrom, args.at),
          or(
            isNull(schema.priceEntries.effectiveTo),
            gt(schema.priceEntries.effectiveTo, args.at),
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
   * Open rows closed because this sync re-priced the same model and class
   * under a different provider name. Left open they would be a second row
   * the reader could pick, so one of two prices would apply and neither
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
   * True when the book held no list row before this sync, so every seed was
   * written effective from {@link COLD_BOOK_EFFECTIVE_FROM} rather than the
   * requested instant, covering the frames that ran before the first sync.
   */
  coldStart: boolean;
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
  /** The write instant; a row effective at or before it is not corrected in place. */
  now?: Date;
}): Promise<PriceBookSyncResult> {
  const requested = args.seeds ?? priceEntriesFromRateCards(args.effectiveFrom);
  const now = args.now ?? new Date();
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
    const existing = await tx
      .select()
      .from(schema.priceEntries)
      .where(
        and(
          isNull(schema.priceEntries.orgId),
          eq(schema.priceEntries.source, "list"),
        ),
      );

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
    // until it holds a row effective from a real instant — the first
    // repricing, which happens once the sources are all answering and a rate
    // moves. Until then a newly discovered key is backdated to the floor,
    // which prices only frames of a model the book had never seen; a key the
    // book already prices is handled at the requested instant as always.
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
    const seen = new Set<string>(existing.map((r) => key(r)));
    // Cold start is also bounded in time, by the book's own creation.
    //
    // Waiting for the first real-instant row alone never ended it for a book
    // whose rates stayed stable: every row sat at the floor forever, so a
    // model a catalog added months later was backdated to the floor too, and
    // a rollup retry priced frames from before that model had any known rate.
    // The first row's `created_at` is durable initialization state. Once
    // COLD_START_WINDOW_MS has passed since it, the book is established and a
    // new key starts at the requested instant like any other change. The
    // window stays long enough for a catalog that was down at first sync to
    // come back and have its models backdated, which is what cold start is
    // for.
    const bookCreatedAt = existing.reduce<number | null>(
      (earliest, r) =>
        earliest === null || r.createdAt.getTime() < earliest
          ? r.createdAt.getTime()
          : earliest,
      null,
    );
    const withinColdWindow =
      bookCreatedAt === null ||
      now.getTime() - bookCreatedAt < COLD_START_WINDOW_MS;
    const coldStart =
      withinColdWindow &&
      !existing.some(
        (r) => r.effectiveFrom.getTime() > COLD_BOOK_EFFECTIVE_FROM.getTime(),
      );
    const effectiveFrom = args.effectiveFrom;
    const seeds = coldStart
      ? requested.map((s) =>
          seen.has(key(s))
            ? s
            : { ...s, effectiveFrom: COLD_BOOK_EFFECTIVE_FROM },
        )
      : requested;

    let written = 0;
    let unchanged = 0;
    let renamed = 0;
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
      // The upsert below corrects a row at the SAME instant in place. That is
      // right while the instant is still ahead — nothing has been priced
      // against the row — and wrong once it has passed: a same-hour re-run of
      // the CLI with a changed catalog rate or alias would rewrite a row that
      // frames earlier in the hour were priced with, so a rollup retry would
      // apply different terms under the same entry id. A change to a shipped
      // row needs a later window, which is what a later --effective-from is.
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
      )
        // Backdating under an open row would leave two rows open for one
        // key; a correction is always a later row.
        throw new RangeError(
          `price for ${key(seed)} is already effective from ${current.effectiveFrom.toISOString()}; a sync must not start earlier`,
        );
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
           currency, micros_per_million, effective_from, effective_to, source)
        VALUES
          (NULL, ${seed.provider}, ${seed.model}, array[${aliases}]::text[],
           ${seed.region}, ${seed.tokenClass}, ${seed.unit}, ${seed.currency},
           ${seed.microsPerMillion.toString()}::bigint,
           ${seed.effectiveFrom.toISOString()}::timestamptz, NULL, 'list')
        ON CONFLICT (coalesce(org_id, '${sql.raw(NIL_UUID)}'::uuid),
                     provider, model, token_class, coalesce(region, ''), effective_from)
        DO UPDATE SET
          micros_per_million = EXCLUDED.micros_per_million,
          currency = EXCLUDED.currency,
          unit = EXCLUDED.unit,
          model_aliases = EXCLUDED.model_aliases,
          effective_to = NULL,
          updated_at = now()
      `);
      if (!pricedTheSame) written += 1;
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
    if (args.retireAbsent === true) {
      const seeded = new Set(seeds.map(key));
      for (const row of existing) {
        if (row.effectiveTo !== null || closedIds.has(row.id)) continue;
        if (seeded.has(key(row))) continue;
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
        // an instant already in force is closed normally below.
        if (row.effectiveFrom.getTime() >= effectiveFrom.getTime()) continue;
        await tx
          .update(schema.priceEntries)
          .set({ effectiveTo: effectiveFrom, updatedAt: new Date() })
          .where(eq(schema.priceEntries.id, row.id));
        closedIds.add(row.id);
        retired += 1;
      }
    }

    return { written, unchanged, renamed, superseded, retired, coldStart };
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
  /** The instant the rate starts applying. */
  effectiveFrom: Date;
  /**
   * The write instant. A row whose `effectiveFrom` is at or before it has
   * shipped and is refused a non-identical in-place correction.
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
 * One lock per NAME the row answers to — its model and every alias — taken
 * in sorted order so two writers never wait on each other's second lock. The
 * resolver treats a model and its aliases as one identity, so a write for
 * `vendor/foo` and a write for `foo` with alias `vendor/foo` are writes to the
 * same thing and must serialise; keyed on the model string alone they would
 * not.
 */
async function lockNegotiatedKey(
  tx: Tx,
  key: NegotiatedPriceKey,
  names: readonly string[] = [key.model],
): Promise<void> {
  const region = key.region ?? null;
  for (const name of [...new Set(names)].sort()) {
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
 * Identity is the model AND its aliases, because that is how the resolver
 * reads a row: an organization that has negotiated `foo` with alias
 * `vendor/foo` and then negotiates `vendor/foo` as a model would hold two
 * live rows for one thing, and a frame would be priced by whichever spelling
 * it happened to report. A write whose names overlap a live row under a
 * different model is refused until that rate is ended.
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
  const from = args.effectiveFrom;
  const now = args.now ?? new Date();
  const key = entryKey({ ...args, region });
  const names = new Set([args.model, ...(modelAliases ?? [])]);

  return withTenantDb(async (tx) => {
    await lockNegotiatedKey(tx, args, [...names]);
    const everyModel = await readKeyRows(tx, args, {
      includeList: false,
      anyProvider: true,
      anyModel: true,
    });
    const live = (r: Row) =>
      r.effectiveTo === null || r.effectiveTo.getTime() > from.getTime();

    // One identity per negotiated class. The resolver matches a frame against
    // a row's model AND its aliases, so a live row under a different model
    // string that shares a name with this write is the same thing priced
    // twice — and a frame would take whichever spelling it reported.
    const overlapping = everyModel.find(
      (r) =>
        r.model !== args.model &&
        live(r) &&
        [r.model, ...r.modelAliases].some((name) => names.has(name)),
    );
    if (overlapping)
      throw new HandlerError({
        code: "conflict",
        reason: "price_entry_alias_conflict",
        message: `${args.model} ${args.tokenClass} shares a name with the negotiated row for ${overlapping.model} (aliases ${JSON.stringify(overlapping.modelAliases)}, effective from ${overlapping.effectiveFrom.toISOString()}); the resolver treats a model and its aliases as one identity, so end that rate before setting this one`,
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
    // An omitted list means "keep the names the rate already has", on both
    // paths a correction can take. On conflict (same instant) the assignment
    // below leaves the row's own aliases alone. A LATER correction inserts a
    // successor instead and never reaches that clause, so the successor
    // inherits the aliases of the row it replaces. Starting it with an empty
    // list dropped every stored alias from that instant on, and calls under
    // those names fell back to list pricing or went unpriced.
    //
    // The same holds when the rate was ENDED and is now being re-established:
    // there is no open row, but the most recent row in the chain still carries
    // the names. `rows` is newest first, so `rows[0]` is that row.
    const inherited =
      modelAliases ?? open?.modelAliases ?? rows[0]?.modelAliases ?? [];
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
  });
}

/** What ending a negotiated rate at an instant did. */
export interface NegotiatedPriceClose {
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
 * A list row is not an organization's to change. The read admits the list rows
 * (the same set the RLS policy shows a tenant session) precisely so this case
 * is distinguishable: a key priced only by the list is refused rather than
 * silently reported as closed, which would leave the customer believing the
 * platform's own price had moved.
 */
export async function closeNegotiatedPriceEntry(args: {
  orgId: string;
  provider: string;
  model: string;
  tokenClass: PriceTokenClass;
  region?: string | null;
  /** The instant the negotiated rate stops applying. */
  at: Date;
  /** The write instant, which decides whether a scheduled row has begun. */
  now?: Date;
}): Promise<NegotiatedPriceClose> {
  const region = args.region ?? null;
  const key = entryKey({ ...args, region });
  const now = args.now ?? new Date();

  return withTenantDb(async (tx) => {
    await lockNegotiatedKey(tx, args);
    const rows = await readKeyRows(tx, args, { includeList: true });
    const own = rows.filter(
      (r) => r.orgId === args.orgId && r.source !== "list",
    );
    if (own.length === 0)
      // The normal path for a bad key on the API and MCP surfaces, where the
      // caller names the entry rather than clicking a row that exists.
      throw new HandlerError({
        code: "conflict",
        reason: "price_entry_not_negotiated",
        message:
          `${key} has no negotiated price for this organization to end` +
          (rows.length > 0
            ? `; it is priced by the platform list, which is not an organization's to change`
            : ``),
      });

    const at = args.at.getTime();
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
        message: `the negotiated price for ${key} effective from ${begun.effectiveFrom.toISOString()} is already in force; it cannot end at ${args.at.toISOString()}, before it starts — end it at or after that instant`,
      });

    if (active === null && scheduled.length === 0)
      return { closed: null, cancelled: [] };

    // A cutoff in the past shortens a window that has already priced runs:
    // every frame between `at` and now would resolve to the list price on a
    // rollup retry while its cost record still cites the negotiated entry.
    // The same refusal the setter gives an in-place correction to a shipped
    // row. `at` at or after the write instant shortens nothing that shipped.
    if (active && at < now.getTime())
      throw new HandlerError({
        code: "conflict",
        reason: "price_entry_window_shipped",
        message: `the negotiated price for ${key} has priced runs between ${args.at.toISOString()} and ${now.toISOString()}; a rate cannot be ended in the past — end it now or at a later instant`,
      });

    if (active) {
      await tx
        .update(schema.priceEntries)
        .set({ effectiveTo: args.at, updatedAt: new Date() })
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
      closed:
        active === null
          ? null
          : rowToEntry({ ...active, effectiveTo: args.at }),
      cancelled: scheduled.map(rowToEntry),
    };
  });
}
