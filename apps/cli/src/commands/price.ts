/**
 * `oxagen price …` — CLI parity surface for `set_price_entry` /
 * `remove_price_entry`. Writes and ends the organization's NEGOTIATED rates:
 * the rows in `cost.price_entries` that carry the org's own id and win over
 * the provider list price for the same model and token class.
 *
 *   oxagen price set --provider <p> --model <m> --token-class <c>
 *                    --usd-per-million <usd> [--alias <a>...]
 *                    [--effective-from <rfc3339>]
 *   oxagen price remove --provider <p> --model <m> --token-class <c>
 *                       [--region <r>] [--at <rfc3339>]
 *
 * Both calls go through the shared org-scoped API client in lib/api.ts. `set`
 * (POST /cost/price-entries/set) uses apiPostOrThrow: not PUT, because a body
 * that omits --effective-from takes the write instant, so a blind retry would
 * open a second window rather than repeat the first write. `remove`
 * (POST /cost/price-entries/remove) uses apiPostOrThrow: nothing is deleted,
 * the row is closed at an instant and kept, because a run priced before it
 * still names the entry it was priced with.
 *
 * `oxagen cost` is the unrelated LOCAL projection off the baked-in rate card;
 * this command is the platform's book, and only an org Owner, Admin or
 * Billing member may write it.
 *
 * A whole rate card is several calls, one per token class, sharing one
 * `--effective-from`. That is the contract's shape and not an omission: each
 * token class is its own effective-dated row, so one call per class is the
 * only way each write is atomic — see the `set_price_entry` contract.
 *
 * Output discipline (ADR-023 §4): `--json` emits the exact contract payload as
 * one line on stdout; pretty mode renders a table; failures are uniform
 * stderr error lines (exit 2 for a bad flag, exit 1 for an API failure).
 */
import { apiPostOrThrow, printTable } from "../lib/api.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

// ── Output shapes (mirror the cost.price_entry.{set,remove} contract output) ─

/** The token classes `cost.price_entries` prices (spec §12.6 plus media). */
const TOKEN_CLASSES = [
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "output",
  "reasoning",
  "server_tool_request",
  "embedding_input",
  "rerank",
  "image",
  "video_second",
] as const;
type TokenClass = (typeof TOKEN_CLASSES)[number];

export interface PriceEntryRow {
  id: string;
  orgId: string | null;
  provider: string;
  model: string;
  modelAliases: string[];
  region: string | null;
  tokenClass: string;
  unit: string;
  currency: string;
  /** Integer micro-units per one million units, as a decimal string. */
  microsPerMillion: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string;
}

interface PriceEntrySetResult {
  entry: PriceEntryRow;
  closed: PriceEntryRow | null;
}

interface PriceEntryRemoveResult {
  at: string;
  closed: PriceEntryRow | null;
  /**
   * Whether a list, override or other negotiated row still prices this
   * model and class from `at` on. False means the class has no fallback and
   * is now unpriced, not list-priced.
   */
  fallbackPriced: boolean;
}

/** The handler's refusal when a close has somewhere live to end but nowhere to fall back to. */
const CLOSE_WOULD_UNPRICE = "price_entry_close_would_unprice";

function isTokenClass(v: string): v is TokenClass {
  return (TOKEN_CLASSES as readonly string[]).includes(v);
}

/**
 * Display only: the wire carries integer micros per million, the terminal
 * prints the USD-per-million figure the contract was written in. Divided as a
 * Number because it is a rendering, never a figure anything is billed from.
 */
function formatPerMillion(row: PriceEntryRow): string {
  const usd = (Number(row.microsPerMillion) / 1_000_000).toFixed(6);
  // Strip only the zeros AFTER the decimal point — a bare /0+$/ turns
  // "10.000000" into "1".
  return `$${usd.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}`;
}

/**
 * `--usd-per-million <usd>` to the contract's number. Parsed from a decimal
 * string so a typo is a usage error rather than a NaN that reaches the API;
 * more than six fractional digits is refused, because the store records
 * micro-USD and anything finer would be silently rounded.
 */
function parseUsdPerMillion(raw: string): number | null {
  if (!/^\d+(?:\.\d{1,6})?$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/** An RFC 3339 instant, normalised the way the contract's `.datetime()` expects. */
function parseInstant(raw: string): string | null {
  const ms = Date.parse(raw.trim());
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function entryRow(row: PriceEntryRow): string[] {
  return [
    row.provider,
    row.model,
    row.tokenClass,
    row.region ?? "—",
    formatPerMillion(row),
    row.source,
    row.effectiveFrom,
    row.effectiveTo ?? "open",
  ];
}

function renderEntries(rows: PriceEntryRow[], writer: CommandWriter): void {
  printTable(
    [
      "ID",
      "PROVIDER",
      "MODEL",
      "CLASS",
      "REGION",
      "PER 1M",
      "SOURCE",
      "FROM",
      "TO",
    ],
    rows.map((row) => [row.id, ...entryRow(row)]),
    writer,
  );
}

// ── price set ─────────────────────────────────────────────────────────────

export interface PriceSetCliOptions {
  provider?: string;
  model?: string;
  tokenClass?: string;
  usdPerMillion?: string;
  alias?: string[];
  effectiveFrom?: string;
  json?: boolean;
}

export async function priceSet(
  opts: PriceSetCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);

  if (!opts.provider || !opts.model) {
    process.exitCode = 2;
    out.error("--provider and --model are both required.", "usage");
    return;
  }
  if (!opts.tokenClass || !isTokenClass(opts.tokenClass)) {
    process.exitCode = 2;
    out.error(
      `Invalid --token-class "${opts.tokenClass ?? ""}". One of: ${TOKEN_CLASSES.join(", ")}.`,
      "usage",
    );
    return;
  }
  const usdPerMillion =
    opts.usdPerMillion === undefined
      ? null
      : parseUsdPerMillion(opts.usdPerMillion);
  if (usdPerMillion === null) {
    process.exitCode = 2;
    out.error(
      `Invalid --usd-per-million "${opts.usdPerMillion ?? ""}". Provide a non-negative USD amount with at most six decimals.`,
      "usage",
    );
    return;
  }
  let effectiveFrom: string | undefined;
  if (opts.effectiveFrom !== undefined) {
    const parsed = parseInstant(opts.effectiveFrom);
    if (parsed === null) {
      process.exitCode = 2;
      out.error(
        `Invalid --effective-from "${opts.effectiveFrom}". Provide an RFC 3339 instant.`,
        "usage",
      );
      return;
    }
    effectiveFrom = parsed;
  }

  let result: PriceEntrySetResult;
  try {
    result = await apiPostOrThrow<PriceEntrySetResult>(
      "cost/price-entries/set",
      {
        provider: opts.provider,
        model: opts.model,
        tokenClass: opts.tokenClass,
        // Always the region-agnostic row. A regional rate would win outside its
        // region because nothing on the pricing path reads `region`, so
        // `set_price_entry` refuses one and the flag is not offered.
        region: null,
        modelAliases: opts.alias?.length ? opts.alias : undefined,
        usdPerMillion,
        effectiveFrom,
      },
    );
  } catch (err) {
    out.error(err, "api");
    return;
  }

  if (out.isJson) {
    out.data(result);
    return;
  }
  writer.write(
    `✓ negotiated ${result.entry.model} ${result.entry.tokenClass} at ${formatPerMillion(result.entry)} per 1M, effective ${result.entry.effectiveFrom}.`,
  );
  writer.write("");
  renderEntries(
    result.closed ? [result.entry, result.closed] : [result.entry],
    writer,
  );
  if (result.closed) {
    writer.write("");
    writer.write(
      `  The previous rate is closed at ${result.closed.effectiveTo}, not overwritten: a run priced before then keeps the entry it used.`,
    );
  }
}

// ── price remove ──────────────────────────────────────────────────────────

export interface PriceRemoveCliOptions {
  provider?: string;
  model?: string;
  tokenClass?: string;
  region?: string;
  at?: string;
  /**
   * States the class may go UNPRICED, not list-priced, once this rate ends.
   * Only read when it would: `remove_price_entry` refuses without it, naming
   * `price_entry_close_would_unprice`, rather than close first and report the
   * gap in the output afterward.
   */
  confirmUnpriced?: boolean;
  scheduledEntryId?: string;
  json?: boolean;
}

export async function priceRemove(
  opts: PriceRemoveCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);

  if (!opts.provider || !opts.model) {
    process.exitCode = 2;
    out.error("--provider and --model are both required.", "usage");
    return;
  }
  if (!opts.tokenClass || !isTokenClass(opts.tokenClass)) {
    process.exitCode = 2;
    out.error(
      `Invalid --token-class "${opts.tokenClass ?? ""}". One of: ${TOKEN_CLASSES.join(", ")}.`,
      "usage",
    );
    return;
  }
  let at: string | undefined;
  if (opts.at !== undefined) {
    const parsed = parseInstant(opts.at);
    if (parsed === null) {
      process.exitCode = 2;
      out.error(
        `Invalid --at "${opts.at}". Provide an RFC 3339 instant.`,
        "usage",
      );
      return;
    }
    at = parsed;
  }

  let result: PriceEntryRemoveResult;
  try {
    result = await apiPostOrThrow<PriceEntryRemoveResult>(
      "cost/price-entries/remove",
      {
        provider: opts.provider,
        model: opts.model,
        tokenClass: opts.tokenClass,
        region: opts.region ?? null,
        at,
        confirmUnpriced: opts.confirmUnpriced ? true : undefined,
        ...(opts.scheduledEntryId === undefined
          ? {}
          : { scheduledEntryId: opts.scheduledEntryId }),
      },
    );
  } catch (err) {
    out.error(err, "api");
    // The one refusal this command can act on directly: the handler already
    // named the fix (set a fallback first, or confirm going unpriced), but
    // named it by the wire field, not the flag a person typing this command
    // would reach for.
    if (
      !out.isJson &&
      err instanceof Error &&
      err.message.includes(CLOSE_WOULD_UNPRICE)
    )
      writer.write("  Re-run with --confirm-unpriced to end the rate anyway.");
    return;
  }

  if (out.isJson) {
    out.data(result);
    return;
  }
  const fallback = result.fallbackPriced
    ? "A fallback price covers this model and class."
    : "No list or override price covers this model and class: it is UNPRICED until one is set.";
  if (opts.scheduledEntryId !== undefined) {
    writer.write(
      `Scheduled rate ${opts.scheduledEntryId} is absent. Active and later rates remain unchanged.`,
    );
    return;
  }
  if (result.closed === null) {
    writer.write(
      `No open negotiated rate for ${opts.model} ${opts.tokenClass}; nothing to end. ${fallback}`,
    );
    return;
  }
  writer.write(
    `✓ ${result.closed.model} ${result.closed.tokenClass} rate ended from ${result.at}. ${fallback}`,
  );
  writer.write("");
  renderEntries([result.closed], writer);
}

/** Read current rates, optionally including this organization's scheduled rows. */
export async function priceList(
  opts: { at?: string; includeScheduled?: boolean; json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const at = opts.at === undefined ? undefined : parseInstant(opts.at);
  if (at === null) {
    process.exitCode = 2;
    out.error("Invalid --at. Provide an RFC 3339 instant.", "usage");
    return;
  }
  try {
    const result = await apiPostOrThrow<{
      at: string;
      entries: PriceEntryRow[];
    }>("cost/price-entries", {
      at,
      ...(opts.includeScheduled ? { includeScheduled: true } : {}),
    });
    if (out.isJson) out.data(result);
    else renderEntries(result.entries, writer);
  } catch (err) {
    out.error(err, "api");
  }
}
