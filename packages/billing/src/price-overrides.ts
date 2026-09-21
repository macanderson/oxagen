/**
 * price-overrides.ts — what this deployment says a model costs.
 *
 * Two audiences, one file:
 *
 *  - The operator who has **no negotiated rates** never touches this. The
 *    published catalogs (./price-sources.ts) and the in-code card price
 *    everything, the sync job loads them on its own, and nothing here is set.
 *  - The operator who **has** negotiated rates — a committed-spend discount
 *    with Anthropic, a private OpenAI contract, a reseller agreement — states
 *    them once in the environment. They then win over every published rate,
 *    for every run, without a database write or a deploy.
 *
 * This is the installation-wide lever. A rate negotiated by one *customer* of
 * a multi-tenant installation is a per-organization row in `cost.price_entries`
 * instead (source `negotiated`, written through `set_price_entry`), which
 * beats the list rows these produce. The precedence, top to bottom, is:
 * an organization's negotiated row → this file → the in-code card → the
 * published catalogs → unpriced.
 *
 * Configure with either:
 *   OXAGEN_PRICE_OVERRIDES       inline JSON
 *   OXAGEN_PRICE_OVERRIDES_FILE  path to a JSON file (wins if both are set)
 *
 * The JSON is a map of model id to rates in **USD per one million tokens**:
 *
 *   {
 *     "claude-sonnet-5": {
 *       "provider": "anthropic",
 *       "inputPer1M": 2.40,
 *       "outputPer1M": 12.00,
 *       "cachedInputPer1M": 0.24,
 *       "cacheWrite5mPer1M": 3.00
 *     }
 *   }
 *
 * Only `inputPer1M` and `outputPer1M` are required. A cache class left out is
 * derived where it can be (a 1h write from the 5m write) and otherwise left
 * unpriced, so a frame that uses it is recorded `estimated` rather than
 * charged at zero. A `models` wrapper around the map is accepted too, since
 * that is how anyone who has seen one config file expects to write it.
 *
 * A malformed override is a loud failure, not a silent fallback: mispricing
 * every run is worse than refusing to start the sync, and the operator who
 * just typed the file is the one who can fix it.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { deriveCacheWrite1h, type PublishedModelPrice } from "./price-sources";

export const PRICE_OVERRIDES_ENV = "OXAGEN_PRICE_OVERRIDES";
export const PRICE_OVERRIDES_FILE_ENV = "OXAGEN_PRICE_OVERRIDES_FILE";

const rateSchema = z
  .object({
    provider: z.string().min(1).optional(),
    aliases: z.array(z.string().min(1)).optional(),
    inputPer1M: z.number().finite().nonnegative(),
    outputPer1M: z.number().finite().nonnegative(),
    cachedInputPer1M: z.number().finite().nonnegative().optional(),
    cacheWrite5mPer1M: z.number().finite().nonnegative().optional(),
    cacheWrite1hPer1M: z.number().finite().nonnegative().optional(),
    reasoningPer1M: z.number().finite().nonnegative().optional(),
  })
  .strict();

const mapSchema = z.record(rateSchema);

/**
 * A `{ "models": { … } }` wrapper is accepted around the map, since that is
 * how anyone who has seen a config file expects to write one. Unwrapping it
 * before the parse rather than parsing a union keeps the parsed map's element
 * type, which a union of two record schemas loses.
 */
function unwrap(body: unknown): unknown {
  if (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    "models" in body &&
    Object.keys(body).length === 1
  )
    return (body as { models: unknown }).models;
  return body;
}

/** A model override is unusable on its own terms — say which model and why. */
export class PriceOverrideError extends Error {
  readonly code = "PRICE_OVERRIDE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "PriceOverrideError";
  }
}

/** The vendor prefix an id carries, or `unknown` when it carries none. */
function vendorOf(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : "unknown";
}

/** A bare id names the same model as its vendor-prefixed form. */
function defaultAliases(model: string): string[] {
  const slash = model.indexOf("/");
  return slash > 0 ? [model.slice(slash + 1)] : [];
}

/** Parse an override document into published prices. Throws on anything malformed. */
export function parsePriceOverrides(body: unknown): PublishedModelPrice[] {
  const parsed = mapSchema.safeParse(unwrap(body));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new PriceOverrideError(`price overrides are not valid:\n${issues}`);
  }
  const map = parsed.data;
  const prices: PublishedModelPrice[] = [];
  for (const [model, rate] of Object.entries(map)) {
    if (model.trim().length === 0)
      throw new PriceOverrideError("a price override names an empty model id");
    const cacheWrite5m = rate.cacheWrite5mPer1M ?? null;
    prices.push({
      model,
      aliases: rate.aliases ?? defaultAliases(model),
      provider: rate.provider ?? vendorOf(model),
      inputPer1M: rate.inputPer1M,
      outputPer1M: rate.outputPer1M,
      cachedInputPer1M: rate.cachedInputPer1M ?? null,
      cacheWrite5mPer1M: cacheWrite5m,
      cacheWrite1hPer1M:
        rate.cacheWrite1hPer1M ??
        deriveCacheWrite1h(
          rate.provider ?? vendorOf(model),
          rate.inputPer1M,
          cacheWrite5m,
        ),
      reasoningPer1M: rate.reasoningPer1M ?? rate.outputPer1M,
      // Still a list row in the book — the operator is stating what the
      // provider bills *this installation*, which is what a list price is —
      // but provenance keeps it distinct so the sync report can say how many
      // models the operator priced by hand.
      source: "operator_override",
    });
  }
  return prices;
}

/**
 * The deployment's price overrides, or an empty list when none are set.
 *
 * Both values default to the environment and are arguments so a test can
 * supply them without mutating `process.env`. The file wins over the inline
 * value so a container can mount a secret without also having to clear the
 * variable it was rolled out with.
 */
export function loadPriceOverrides(
  args: {
    /** Defaults to `OXAGEN_PRICE_OVERRIDES_FILE`. */
    filePath?: string | undefined;
    /** Defaults to `OXAGEN_PRICE_OVERRIDES`. */
    inline?: string | undefined;
    readFile?: (path: string) => string;
  } = {},
): PublishedModelPrice[] {
  const path = (args.filePath ?? process.env[PRICE_OVERRIDES_FILE_ENV])?.trim();
  const inline = (args.inline ?? process.env[PRICE_OVERRIDES_ENV])?.trim();
  const readFile = args.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  let raw: string;
  let origin: string;
  if (path !== undefined && path.length > 0) {
    origin = `${PRICE_OVERRIDES_FILE_ENV}=${path}`;
    try {
      raw = readFile(path);
    } catch (err) {
      throw new PriceOverrideError(
        `${origin} could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (inline !== undefined && inline.length > 0) {
    origin = PRICE_OVERRIDES_ENV;
    raw = inline;
  } else {
    return [];
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    throw new PriceOverrideError(
      `${origin} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return parsePriceOverrides(body);
  } catch (err) {
    if (err instanceof PriceOverrideError)
      throw new PriceOverrideError(`${origin}: ${err.message}`);
    throw err;
  }
}
