// A run row's token counts and cache rate, from the same `cost.run_totals`
// row its cost comes from (#3834; spec §12.6).
//
// `tokens` is NOT NULL on the rollup row, so a run the rollup counted but
// could not price still has counts. Only a run with no row at all reads null.
// Nothing here fills a missing row with zeros: a run nobody rolled up is not
// a run that used no tokens.
import { ZERO_TOKENS } from "@oxagen/billing";
import { type RunItem } from "@oxagen/oxagen/contracts/run.list";
import { tokenCountsSchema } from "@oxagen/oxagen/contracts/spend.shared";

/** The rollup columns this reads. `undefined` means the read did not select them. */
export type RollupTokenColumns = {
  /** `cost.run_totals.tokens`, the jsonb as stored. */
  tokens?: unknown;
  /** `cost.run_totals.cache_hit_rate`, already a number or null. */
  cacheHitRate?: number | null;
};

/**
 * The stored counts as the contract's six classes. A class the row left out
 * is zero, as the rollup writes it (`ZERO_TOKENS`). Null when the jsonb is
 * not an object of non-negative integer counts, so a broken row reads as not
 * recorded rather than as a figure nobody measured. A class the contract
 * does not name is left out, so a rollup that learns a new class does not
 * blank every row.
 */
export function tokenCountsOf(stored: unknown): RunItem["tokens"] {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored))
    return null;
  const row = stored as Record<string, unknown>;
  const picked = Object.fromEntries(
    Object.entries(ZERO_TOKENS).map(([key, zero]) => [key, row[key] ?? zero]),
  );
  const counts = tokenCountsSchema.safeParse(picked);
  return counts.success ? counts.data : null;
}

/** A ratio from 0 to 1, or null. A figure outside that range was never a rate. */
function ratioOf(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value >= 0 && value <= 1 ? value : null;
}

/**
 * `tokens` and `cacheHitRate` for a row. No rollup row: both null. A reader
 * that did not select the columns: both absent, so a caller reads "not
 * looked at" and not "not recorded".
 */
export function rollupTokenFields(
  rollup: RollupTokenColumns | undefined,
): Pick<RunItem, "tokens" | "cacheHitRate"> {
  if (rollup === undefined) return { tokens: null, cacheHitRate: null };
  if (rollup.tokens === undefined) return {};
  return {
    tokens: tokenCountsOf(rollup.tokens),
    cacheHitRate: ratioOf(rollup.cacheHitRate),
  };
}
