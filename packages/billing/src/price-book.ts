/**
 * price-book.ts — the price book as data (Mission Control spec §12.2, ADR-058).
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
 * the only reader (ADR-058 §1).
 */
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import type { PriceTokenClass, PriceUnit } from "@oxagen/database/schema";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
  IMAGE_RATE_CARD,
  PROVIDER_RATE_CARD,
  VIDEO_RATE_CARD,
  type ImageModelRate,
  type RateCard,
  type VideoModelRate,
} from "./pricing";

export type { PriceTokenClass, PriceUnit } from "@oxagen/database/schema";

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
 * The entries the active tenant may read — the list and its own negotiated
 * rows, which is what the `org_or_global` policy admits — effective at `at`,
 * ordered for a list: provider, model, class, latest first.
 */
export async function listPriceEntries(args: {
  at: Date;
}): Promise<PriceEntry[]> {
  const rows = await withTenantDb((tx) =>
    tx
      .select()
      .from(schema.priceEntries)
      .where(
        and(
          sql`${schema.priceEntries.effectiveFrom} <= ${args.at}`,
          or(
            isNull(schema.priceEntries.effectiveTo),
            sql`${schema.priceEntries.effectiveTo} > ${args.at}`,
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

export interface PriceBookSyncResult {
  /** Rows written (inserted or updated in place, before they have shipped). */
  written: number;
  /** Rows whose price was unchanged. */
  unchanged: number;
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
        current.effectiveFrom.getTime() < seed.effectiveFrom.getTime()
      ) {
        await tx
          .update(schema.priceEntries)
          .set({ effectiveTo: seed.effectiveFrom, updatedAt: new Date() })
          .where(eq(schema.priceEntries.id, current.id));
      }
      await tx.execute(sql`
        INSERT INTO ${schema.priceEntries}
          (org_id, provider, model, model_aliases, region, token_class, unit,
           currency, micros_per_million, effective_from, effective_to, source)
        VALUES
          (NULL, ${seed.provider}, ${seed.model}, ${[...seed.modelAliases]}::text[],
           ${seed.region}, ${seed.tokenClass}, ${seed.unit}, ${seed.currency},
           ${seed.microsPerMillion}, ${seed.effectiveFrom}, NULL, 'list')
        ON CONFLICT (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid),
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
    return { written, unchanged };
  });
}
