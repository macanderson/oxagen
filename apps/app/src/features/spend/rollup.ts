// Figures the Spend page derives from the rows `get_spend` answered (#2962):
// token sums by class, the cache hit rate, a row's tokens per run, and the
// savings of the findings that name one key. Every one is a rollup of the rows
// beneath it, computed once here so a tile and the table it heads cannot
// disagree (spec: "Headers are rollups of the rows beneath them, never typed
// twice"). Money arithmetic goes through src/data/contracts/money.ts (INV-09).
import { type Cost, sumMoney } from "@/data/contracts/money";
import type {
  SpendDrillKind,
  SpendFinding,
  SpendReport,
} from "@/data/contracts/spend";

type Tokens = SpendReport["rows"][number]["tokens"];

/** The five classes the page prints; the two cache-write TTLs fold into one. */
export const TOKEN_CLASSES = [
  "input_uncached",
  "cache_read",
  "cache_write",
  "output",
  "reasoning",
] as const;
type TokenClass = (typeof TOKEN_CLASSES)[number];
export type TokenClasses = Record<TokenClass, number>;

/** One row's tokens in the page's five classes. */
export function classesOf(tokens: Tokens): TokenClasses {
  return {
    input_uncached: tokens.input_uncached,
    cache_read: tokens.cache_read,
    cache_write: tokens.cache_write_5m + tokens.cache_write_1h,
    output: tokens.output,
    reasoning: tokens.reasoning,
  };
}

/**
 * The classes summed over every row. Sum one level only: the model rows and
 * the agent rows count the same calls, so adding two levels counts them twice.
 */
export function sumClasses(rows: readonly { tokens: Tokens }[]): TokenClasses {
  const total: TokenClasses = {
    input_uncached: 0,
    cache_read: 0,
    cache_write: 0,
    output: 0,
    reasoning: 0,
  };
  for (const { tokens } of rows) {
    const row = classesOf(tokens);
    for (const key of TOKEN_CLASSES) total[key] += row[key];
  }
  return total;
}

export function totalOf(classes: TokenClasses): number {
  return TOKEN_CLASSES.reduce((sum, key) => sum + classes[key], 0);
}

/**
 * cache_read ÷ (input_uncached + cache_read), token-weighted. Null when no
 * input token was read: a rate over nothing is not a zero.
 */
export function cacheHitRate(classes: TokenClasses): number | null {
  const input = classes.input_uncached + classes.cache_read;
  return input === 0 ? null : classes.cache_read / input;
}

/** The share of completion tokens that were reasoning; null with no completion. */
export function reasoningShare(classes: TokenClasses): number | null {
  const completion = classes.output + classes.reasoning;
  return completion === 0 ? null : classes.reasoning / completion;
}

/** Whole tokens per run; null for a row with no run. */
export function perRun(tokens: number, runs: number): number | null {
  return runs === 0 ? null : Math.round(tokens / runs);
}

/** The findings whose level and subject name this key. */
export function findingsOn(
  findings: readonly SpendFinding[],
  level: SpendDrillKind,
  key: string,
): SpendFinding[] {
  return findings.filter(
    (finding) => finding.level === level && finding.subject === key,
  );
}

/**
 * The basis of a sum: the one basis every part shares, and otherwise the
 * weakest claim the parts can carry together. A part nobody recorded a basis
 * for leaves the sum without one; an estimated part makes the sum estimated;
 * observed and attested parts together are `mixed`. Never stronger than a part.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function basisOf(parts: readonly Cost[]): Cost["basis"] {
  const bases = new Set(parts.map((part) => part.basis));
  if (bases.has(null)) return null;
  if (bases.size === 1) return parts[0]?.basis ?? null;
  if (bases.has("estimated")) return "estimated";
  return "mixed";
}

/** The sum of costs with the basis the parts carry together, or null for none. */
export function sumCost(parts: readonly Cost[]): Cost | null {
  const money = sumMoney(parts);
  return money === null ? null : { ...money, basis: basisOf(parts) };
}

/** What a key's own findings have at stake, or null when it has none. */
export function savingOf(findings: readonly SpendFinding[]): Cost | null {
  return sumCost(findings.map((finding) => finding.saving));
}
