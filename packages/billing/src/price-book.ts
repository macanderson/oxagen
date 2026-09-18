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
import type { PriceTokenClass, PriceUnit } from "@oxagen/database/schema";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
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
  /** Rows whose price was unchanged. */
  unchanged: number;
  /**
   * Open rows closed because this sync re-priced the same model and class
   * under a different provider name. Left open they would be a second row
   * the reader could pick, so one of two prices would apply and neither
   * would be predictable.
   */
  superseded: number;
}

/**
 * Write the list price book from the in-code cards. Idempotent on the row key
 * (provider, model, class, region, effective_from): a re-run with the same
 * `effectiveFrom` updates a changed price in place, a run with a later
 * `effectiveFrom` adds the new rows and closes the previous ones at that
 * instant, so a run priced before the change keeps the entry it used.
 * Negotiated rows are never touched.
 */
export async function syncPriceBook(args: {
  effectiveFrom: Date;
  seeds?: readonly PriceEntrySeed[];
}): Promise<PriceBookSyncResult> {
  const seeds = args.seeds ?? priceEntriesFromRateCards(args.effectiveFrom);
  return withSystemDb(async (tx) => {
    const existing = await tx
      .select()
      .from(schema.priceEntries)
      .where(
        and(
          isNull(schema.priceEntries.orgId),
          eq(schema.priceEntries.source, "list"),
        ),
      );
    const key = (e: {
      provider: string;
      model: string;
      tokenClass: string;
      region: string | null;
    }) => `${e.provider}|${e.model}|${e.tokenClass}|${e.region ?? ""}`;
    const open = new Map<string, Row>();
    for (const row of existing)
      if (row.effectiveTo === null) open.set(key(row), row);

    let written = 0;
    let unchanged = 0;
    for (const seed of seeds) {
      const current = open.get(key(seed));
      if (
        current &&
        current.microsPerMillion === seed.microsPerMillion &&
        current.currency === seed.currency &&
        current.unit === seed.unit
      ) {
        unchanged += 1;
        continue;
      }
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
          effective_to = NULL,
          updated_at = now()
      `);
      written += 1;
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
    let superseded = 0;
    for (const row of existing) {
      if (row.effectiveTo !== null) continue;
      const seed = writtenKeys.get(supersededKey(row));
      if (!seed) continue;
      if (seed.provider === row.provider) continue;
      if (row.effectiveFrom.getTime() >= seed.effectiveFrom.getTime()) continue;
      await tx
        .update(schema.priceEntries)
        .set({ effectiveTo: seed.effectiveFrom, updatedAt: new Date() })
        .where(eq(schema.priceEntries.id, row.id));
      superseded += 1;
    }

    return { written, unchanged, superseded };
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
 */
async function readKeyRows(
  tx: Tx,
  key: NegotiatedPriceKey,
  options: { includeList: boolean },
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
        eq(schema.priceEntries.provider, key.provider),
        eq(schema.priceEntries.model, key.model),
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
 * Write one organization's negotiated rate for a (provider, model, token
 * class, region), effective from `effectiveFrom`.
 *
 * The row key is the unique index's: a re-run with the same `effectiveFrom`
 * updates that row's price, currency, unit and aliases in place, so the call
 * is idempotent. A run with a LATER `effectiveFrom` never touches the shipped
 * row — it closes it at the new instant and inserts a new one, so a run priced
 * before the change keeps the entry it was priced with and a recomputed cost
 * record still resolves that id. A backdated write under an open row is
 * refused for the same reason {@link syncPriceBook} refuses one: it would
 * leave two rows open for one key, and it would reprice runs that already
 * settled.
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
  const modelAliases = args.modelAliases ?? [];
  const from = args.effectiveFrom;
  const key = entryKey({ ...args, region });

  return withTenantDb(async (tx) => {
    const rows = await readKeyRows(tx, args, { includeList: false });

    // A correction is always a later row. A row already effective from an
    // instant after this one — open or since superseded — means this write
    // would either leave two rows open for the key or reprice a window that
    // has already settled.
    const later = rows.filter(
      (r) => r.effectiveFrom.getTime() > from.getTime(),
    );
    const earliestLater = later[later.length - 1];
    if (earliestLater)
      throw new RangeError(
        `a negotiated price for ${key} is already effective from ${earliestLater.effectiveFrom.toISOString()}; a correction must not start earlier`,
      );

    // The upsert clears `effective_to`, so a row at exactly this instant that
    // has already been closed would be reopened and the window between its
    // close and now would silently become negotiated again.
    const atInstant = rows.find(
      (r) => r.effectiveFrom.getTime() === from.getTime(),
    );
    if (atInstant && atInstant.effectiveTo !== null)
      throw new RangeError(
        `the negotiated price for ${key} effective from ${from.toISOString()} was ended at ${atInstant.effectiveTo.toISOString()}; re-establish it as a new row with a later effectiveFrom`,
      );

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
    const aliases = sql.join(
      modelAliases.map((a) => sql`${a}`),
      sql`, `,
    );
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
        model_aliases = EXCLUDED.model_aliases,
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

/**
 * End an organization's negotiated row for one key at `at`, so every frame
 * from that instant on resolves to the list price again.
 *
 * It closes the row — `effective_to = at` — and never deletes it: a cost
 * record priced before `at` still names the entry, and the rollup can still
 * read it. Re-closing a key the organization has already ended is a no-op that
 * answers null, so a retry is safe.
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
}): Promise<PriceEntry | null> {
  const region = args.region ?? null;
  const key = entryKey({ ...args, region });

  return withTenantDb(async (tx) => {
    const rows = await readKeyRows(tx, args, { includeList: true });
    const own = rows.filter(
      (r) => r.orgId === args.orgId && r.source !== "list",
    );
    if (own.length === 0)
      throw new RangeError(
        `${key} has no negotiated price for this organization to end` +
          (rows.length > 0
            ? `; it is priced by the platform list, which is not an organization's to change`
            : ``),
      );

    const open = own.find((r) => r.effectiveTo === null);
    if (!open) return null;
    if (open.effectiveFrom.getTime() >= args.at.getTime())
      throw new RangeError(
        `the negotiated price for ${key} is effective from ${open.effectiveFrom.toISOString()}; it cannot end at or before it starts`,
      );

    await tx
      .update(schema.priceEntries)
      .set({ effectiveTo: args.at, updatedAt: new Date() })
      .where(eq(schema.priceEntries.id, open.id));
    return rowToEntry({ ...open, effectiveTo: args.at });
  });
}
