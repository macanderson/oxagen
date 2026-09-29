// Which ranked spend items one chart can draw. A plain module rather than part
// of the "use client" chart, so the server-rendered tables can rank their rows
// with it before handing them to the chart.
import { byMicrosDescending, type Money } from "@/data/contracts/money";

/** One ranked key and its amount. */
export type RankedSpendItem = { key: string; value: Money };

/**
 * The items one chart draws, largest first, and how many it leaves out. A bar
 * is a share of the leading amount, and an amount in another currency has no
 * share of it (ratioOfMicros returns null), so a bar for it would be a guess.
 * The chart keeps the currency most items carry, the earlier code on a tie.
 * The caller's footer names the rest, which the table beside it still holds.
 */
export function rankInOneCurrency(items: readonly RankedSpendItem[]): {
  ranked: RankedSpendItem[];
  otherCurrency: number;
} {
  const counts = new Map<string, number>();
  for (const { value } of items)
    counts.set(value.currency, (counts.get(value.currency) ?? 0) + 1);
  const currency = [...counts].sort(
    ([a, x], [b, y]) => y - x || a.localeCompare(b),
  )[0]?.[0];
  const ranked = items
    .filter(({ value }) => value.currency === currency)
    .sort((a, b) => byMicrosDescending(a.value, b.value));
  return { ranked, otherCurrency: items.length - ranked.length };
}
