/**
 * price-sources.ts — where a list price comes from when nobody typed it in.
 *
 * The price book (./price-book.ts) is the thing the rollup resolves against,
 * and it ships empty. Three sources fill it, in this precedence:
 *
 *   1. **Operator overrides** (./price-overrides.ts) — what this deployment
 *      says a model costs. Always wins: an operator who has negotiated a rate
 *      with a provider for the whole installation states it once in the
 *      environment and never thinks about it again.
 *   2. **The in-code rate card** (./pricing.ts) — the models Oxagen has
 *      reconciled against real provider invoices. Hand-verified, so it beats
 *      a catalog scrape for the models it names.
 *   3. **Published catalogs** — every other model. Providers do not publish
 *      machine-readable price lists of their own (Anthropic, OpenAI and
 *      Google publish model *lists* with no prices on them), so the published
 *      rates are read from the two catalogs that do carry them: OpenRouter's
 *      model API and models.dev. Both are public and need no credential.
 *
 * A model none of the three names is **unpriced** — not free. The rollup
 * records it as such (./cost-rollup.ts `priceFrame`) and ./unpriced-models.ts
 * is what tells the customer which models those are, so they can state a rate
 * instead of reading a run that silently cost nothing.
 *
 * Every fetch here is best-effort by construction: a catalog that is down,
 * slow or malformed yields no rows and a reported failure, never a throw and
 * never a wrong price. The in-code card alone is always enough to seed a
 * usable book, so the sync job (`cost.price-book-sync`) can always make
 * progress.
 */
import { z } from "zod";
import {
  PROVIDER_RATE_CARD,
  type ProviderModelRate,
  type RateCard,
} from "./pricing";
import { isSameModelIdentity } from "./model-identity";
import { usdPerMillionToMicros, type PriceEntrySeed } from "./price-book";
import type { PriceTokenClass } from "@oxagen/database/schema";

/** A catalog we can read published prices from. */
export type PriceSourceId =
  | "operator_override"
  | "in_code_card"
  | "openrouter"
  | "models_dev";

/**
 * One model's published rates, normalized to USD per one million tokens.
 * `null` means the catalog says nothing about that class — which is not the
 * same as zero, and is why every field that can be absent is nullable.
 */
export interface PublishedModelPrice {
  /** The id the catalog names the model by; the price book matches on it by prefix. */
  model: string;
  /** Other ids that resolve to the same price — the gateway-prefixed form, mostly. */
  aliases: string[];
  /** The vendor that bills for it, as the catalog reports it. */
  provider: string;
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M: number | null;
  cacheWrite5mPer1M: number | null;
  cacheWrite1hPer1M: number | null;
  reasoningPer1M: number | null;
  source: PriceSourceId;
}

/** What one catalog read produced. A failure is data, not an exception. */
export interface PriceSourceResult {
  source: PriceSourceId;
  prices: PublishedModelPrice[];
  /** Null on success; the reason the catalog contributed nothing otherwise. */
  error: string | null;
}

/** The default read timeout for a catalog. A slow catalog must not stall the sync. */
const FETCH_TIMEOUT_MS = 15_000;

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const MODELS_DEV_URL = "https://models.dev/api.json";

/**
 * Anthropic's one-hour cache writes bill at 2x base input against the
 * 5-minute tier's 1.25x. No catalog publishes the 1h rate as its own field,
 * so it is derived from the write premium the 5m rate already shows: a model
 * whose 5m write carries a premium gets the 1h rate at the same multiple of
 * base input that the provider charges (2.0/1.25 = 1.6x the 5m rate). A model
 * with no write premium (OpenAI's automatic caching, where a write bills at
 * fresh input rate) has no 1h tier either, and keeps the write rate it has.
 */
const ONE_HOUR_OVER_FIVE_MINUTE = 2 / 1.25;

/** Derive the 1h cache-write rate from a model's input and 5m write rates. */
export function deriveCacheWrite1h(
  inputPer1M: number,
  cacheWrite5mPer1M: number | null,
): number | null {
  if (cacheWrite5mPer1M === null) return null;
  // No premium over fresh input means the provider has no write tier to scale.
  if (cacheWrite5mPer1M <= inputPer1M) return cacheWrite5mPer1M;
  return cacheWrite5mPer1M * ONE_HOUR_OVER_FIVE_MINUTE;
}

// ── The in-code card as a source ──────────────────────────────────────────────

/** A vendor-prefixed id names the same model as its bare form, and vice versa. */
function aliasesFor(model: string): string[] {
  const slash = model.indexOf("/");
  return slash >= 0 ? [model.slice(slash + 1)] : [];
}

function rateToPublished(
  model: string,
  rate: ProviderModelRate,
): PublishedModelPrice {
  return {
    model,
    aliases: aliasesFor(model),
    provider: rate.provider,
    inputPer1M: rate.inputPer1M,
    outputPer1M: rate.outputPer1M,
    cachedInputPer1M: rate.cachedInputPer1M,
    cacheWrite5mPer1M: rate.cacheWritePer1M,
    cacheWrite1hPer1M: deriveCacheWrite1h(
      rate.inputPer1M,
      rate.cacheWritePer1M,
    ),
    // Reasoning tokens bill at the output rate on every provider that meters
    // them separately; pricing them explicitly keeps a frame that reports them
    // from falling to `estimated` for want of an entry.
    reasoningPer1M: rate.outputPer1M,
    source: "in_code_card",
  };
}

/** The in-code rate card as published prices. Pure; no I/O. */
export function inCodeCardPrices(
  card: RateCard = PROVIDER_RATE_CARD,
): PublishedModelPrice[] {
  return Object.entries(card).map(([model, rate]) =>
    rateToPublished(model, rate),
  );
}

// ── OpenRouter ────────────────────────────────────────────────────────────────

/**
 * OpenRouter's `/api/v1/models`. Prices are strings in USD **per token**, so
 * every figure is scaled by a million here. Unknown and extra fields are
 * ignored rather than rejected: a catalog that grows a field must not stop
 * the sync.
 */
const openRouterSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string().min(1),
        canonical_slug: z.string().min(1).optional(),
        pricing: z
          .object({
            prompt: z.string().optional(),
            completion: z.string().optional(),
            input_cache_read: z.string().optional(),
            input_cache_write: z.string().optional(),
            internal_reasoning: z.string().optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  ),
});

/**
 * A catalog's price string → USD per 1M, or null when the catalog says
 * nothing usable. An empty string is *absent*, not free: `Number("")` is 0,
 * so parsing it as a number would publish a zero price for a model whose rate
 * the catalog simply did not state, which is the one thing this module exists
 * to prevent.
 */
function perTokenToPerMillion(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1_000_000;
}

/** The vendor prefix OpenRouter puts on an id (`anthropic/claude-…`). */
function vendorOf(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : "unknown";
}

export function parseOpenRouterCatalog(body: unknown): PublishedModelPrice[] {
  const parsed = openRouterSchema.safeParse(body);
  if (!parsed.success) return [];
  const prices: PublishedModelPrice[] = [];
  for (const row of parsed.data.data) {
    const input = perTokenToPerMillion(row.pricing.prompt);
    const output = perTokenToPerMillion(row.pricing.completion);
    // A model with no input or output rate prices nothing; a free model
    // legitimately reports 0 for both, and 0 is a price we can apply.
    if (input === null || output === null) continue;
    // OpenRouter serves a model under a routing id (`anthropic/claude-sonnet-5`)
    // and names the vendor's own id in `canonical_slug`; both must price.
    const aliases = new Set<string>(aliasesFor(row.id));
    if (row.canonical_slug !== undefined && row.canonical_slug !== row.id) {
      aliases.add(row.canonical_slug);
      for (const a of aliasesFor(row.canonical_slug)) aliases.add(a);
    }
    aliases.delete(row.id);
    const cacheWrite5m = perTokenToPerMillion(row.pricing.input_cache_write);
    prices.push({
      model: row.id,
      aliases: [...aliases],
      provider: vendorOf(row.id),
      inputPer1M: input,
      outputPer1M: output,
      cachedInputPer1M: perTokenToPerMillion(row.pricing.input_cache_read),
      cacheWrite5mPer1M: cacheWrite5m,
      cacheWrite1hPer1M: deriveCacheWrite1h(input, cacheWrite5m),
      reasoningPer1M:
        perTokenToPerMillion(row.pricing.internal_reasoning) ?? output,
      source: "openrouter",
    });
  }
  return prices;
}

// ── models.dev ────────────────────────────────────────────────────────────────

/**
 * models.dev's `api.json`: providers keyed by id, each with a `models` map.
 * Costs are already USD per one million tokens.
 */
const modelsDevSchema = z.record(
  z
    .object({
      id: z.string().optional(),
      models: z.record(
        z
          .object({
            id: z.string().optional(),
            cost: z
              .object({
                input: z.number().optional(),
                output: z.number().optional(),
                cache_read: z.number().optional(),
                cache_write: z.number().optional(),
                reasoning: z.number().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
);

function finiteOrNull(n: number | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseModelsDevCatalog(body: unknown): PublishedModelPrice[] {
  const parsed = modelsDevSchema.safeParse(body);
  if (!parsed.success) return [];
  const prices: PublishedModelPrice[] = [];
  for (const [providerKey, provider] of Object.entries(parsed.data)) {
    const vendor = provider.id ?? providerKey;
    for (const [modelKey, model] of Object.entries(provider.models)) {
      const id = model.id ?? modelKey;
      const input = finiteOrNull(model.cost?.input);
      const output = finiteOrNull(model.cost?.output);
      if (input === null || output === null) continue;
      const cacheWrite5m = finiteOrNull(model.cost?.cache_write);
      prices.push({
        model: id,
        // The gateway-prefixed form of the same model must price too.
        aliases: [`${vendor}/${id}`],
        provider: vendor,
        inputPer1M: input,
        outputPer1M: output,
        cachedInputPer1M: finiteOrNull(model.cost?.cache_read),
        cacheWrite5mPer1M: cacheWrite5m,
        cacheWrite1hPer1M: deriveCacheWrite1h(input, cacheWrite5m),
        reasoningPer1M: finiteOrNull(model.cost?.reasoning) ?? output,
        source: "models_dev",
      });
    }
  }
  return prices;
}

// ── Fetching ──────────────────────────────────────────────────────────────────

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Read one catalog. Never throws: a failure comes back as `error`. */
async function readCatalog(
  source: PriceSourceId,
  url: string,
  parse: (body: unknown) => PublishedModelPrice[],
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<PriceSourceResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok)
      return { source, prices: [], error: `${url} answered ${res.status}` };
    const prices = parse(await res.json());
    if (prices.length === 0)
      return { source, prices: [], error: `${url} carried no usable prices` };
    return { source, prices, error: null };
  } catch (err) {
    return {
      source,
      prices: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read every published catalog, concurrently. The in-code card is not read
 * here — it needs no I/O and {@link mergePublishedPrices} always has it.
 */
export async function fetchPublishedPrices(
  args: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    /** Which catalogs to read; both by default. */
    sources?: readonly Exclude<PriceSourceId, "in_code_card">[];
  } = {},
): Promise<PriceSourceResult[]> {
  const fetchImpl =
    args.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = args.timeoutMs ?? FETCH_TIMEOUT_MS;
  const wanted = args.sources ?? (["openrouter", "models_dev"] as const);
  const reads: Promise<PriceSourceResult>[] = [];
  for (const source of wanted) {
    if (source === "openrouter")
      reads.push(
        readCatalog(
          "openrouter",
          OPENROUTER_MODELS_URL,
          parseOpenRouterCatalog,
          fetchImpl,
          timeoutMs,
        ),
      );
    if (source === "models_dev")
      reads.push(
        readCatalog(
          "models_dev",
          MODELS_DEV_URL,
          parseModelsDevCatalog,
          fetchImpl,
          timeoutMs,
        ),
      );
  }
  return Promise.all(reads);
}

// ── Merge ─────────────────────────────────────────────────────────────────────

/** Where each model in the merged book got its price. */
export type PriceProvenance = Map<string, PriceSourceId>;

export interface MergedPrices {
  prices: PublishedModelPrice[];
  provenance: PriceProvenance;
  /** How many models each source contributed, after precedence. */
  counts: Record<PriceSourceId, number>;
}

/**
 * Fold sources into one price per model id, highest precedence first. The
 * caller passes them in precedence order (overrides, then the in-code card,
 * then catalogs) and the first mention of a model id wins outright — a
 * partial merge across sources would price one model's input from an invoice
 * and its cache read from a scrape, which is how a total nobody can explain
 * gets built.
 */
export function mergePublishedPrices(
  groups: readonly (readonly PublishedModelPrice[])[],
): MergedPrices {
  const byModel = new Map<string, PublishedModelPrice>();
  const provenance: PriceProvenance = new Map();
  // Every name a winning price has claimed — its own id and its aliases.
  // Claiming the aliases too is what makes an override actually bind.
  //
  // A model reaches billing under two ids: the bare family (`claude-sonnet-5`)
  // and the gateway form (`anthropic/claude-sonnet-5`), and the in-code card
  // carries BOTH as separate keys. Keyed on the model id alone, an operator
  // who overrides `claude-sonnet-5` would win that row while the card still
  // wrote `anthropic/claude-sonnet-5` at list price — and `resolvePriceEntry`
  // matches a gateway-form id against the longer `anthropic/…` row before it
  // falls back to the bare family, so every gateway call would quietly bill at
  // list price and the negotiated rate would apply to nothing. One name per
  // model, and the row that wins carries the aliases that serve the other form.
  const claimed = new Set<string>();
  // The names higher-precedence groups have claimed, as families. The
  // resolver does not match a name exactly: it takes the LONGEST name that
  // prefixes the frame's model id. So an operator override for
  // `claude-sonnet` and the card's `claude-sonnet-5` would both survive an
  // exact-name merge, and a frame for `claude-sonnet-5-20260901` would then
  // pick the longer list row and bypass the installation-wide negotiated rate
  // — silently, since both rows are "there". A lower group's price is
  // therefore dropped when any of its names is the same model identity as a
  // name a higher group claimed: a higher source that names a family owns the
  // family. Within one group both survive, since the same source published
  // both and the longer match is the more specific price it meant.
  //
  // Same identity, not the same leading characters, not merely a segment
  // boundary and not a version number either: only an explicit alias or a
  // point-in-time stamp inherits. So an override for `gpt-4o` leaves the
  // catalog's separately priced `gpt-4o-mini` row alone, and an override for
  // `gpt-5` leaves the `gpt-5.2` and `gpt-5.5` rows alone — three products at
  // three prices in the card, and dropping two of them would have priced
  // their calls at the negotiated `gpt-5` rate — see
  // {@link isSameModelIdentity}.
  const claimedAbove: string[] = [];
  const counts: Record<PriceSourceId, number> = {
    operator_override: 0,
    in_code_card: 0,
    openrouter: 0,
    models_dev: 0,
  };
  for (const group of groups) {
    const claimedHere: string[] = [];
    for (const price of group) {
      const names = [price.model, ...price.aliases];
      if (names.some((n) => claimed.has(n))) continue;
      if (
        names.some((n) =>
          claimedAbove.some((above) => isSameModelIdentity(n, above)),
        )
      )
        continue;
      for (const name of names) {
        claimed.add(name);
        claimedHere.push(name);
      }
      byModel.set(price.model, price);
      provenance.set(price.model, price.source);
      counts[price.source] += 1;
    }
    claimedAbove.push(...claimedHere);
  }
  return { prices: [...byModel.values()], provenance, counts };
}

// ── Seeds ─────────────────────────────────────────────────────────────────────

/** The token classes a published price states, and the field each reads. */
const SEED_CLASSES: readonly (readonly [
  PriceTokenClass,
  keyof PublishedModelPrice,
])[] = [
  ["input_uncached", "inputPer1M"],
  ["cache_read", "cachedInputPer1M"],
  ["cache_write_5m", "cacheWrite5mPer1M"],
  ["cache_write_1h", "cacheWrite1hPer1M"],
  ["output", "outputPer1M"],
  ["reasoning", "reasoningPer1M"],
];

/**
 * Published prices → price-book seeds, one row per model and token class. A
 * class the catalog says nothing about produces no row, so the rollup records
 * a frame that uses it as `estimated` rather than pricing it at zero.
 */
export function seedsFromPublishedPrices(
  prices: readonly PublishedModelPrice[],
  effectiveFrom: Date,
): PriceEntrySeed[] {
  const rows: PriceEntrySeed[] = [];
  for (const price of prices) {
    for (const [tokenClass, field] of SEED_CLASSES) {
      const usd = price[field];
      if (typeof usd !== "number") continue;
      rows.push({
        provider: price.provider,
        model: price.model,
        modelAliases: price.aliases,
        region: null,
        tokenClass,
        unit: "token",
        currency: "USD",
        microsPerMillion: usdPerMillionToMicros(usd),
        effectiveFrom,
        effectiveTo: null,
        // Recorded, so a withdrawn override can retire on a run where a
        // catalog is down: the row says who wrote it.
        source: price.source === "operator_override" ? "override" : "list",
        catalog: price.source,
      });
    }
  }
  return rows;
}
