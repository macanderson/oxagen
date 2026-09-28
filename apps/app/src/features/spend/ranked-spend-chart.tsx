"use client";
// A ranked bar chart of money, largest first, drawn with the chart kit
// (@/ui/chart). Spend's By tool and By agent views put one beside their table,
// which holds every row: the chart answers which few keys carry the spend, and
// the table answers everything else, so the table is the chart's text
// equivalent. A bar's length is its share of the leading value, as a float
// from ratioOfMicros (INV-09); the money printed at its end is the exact
// figure, formatted from the row's micros. The caller leaves out a key whose
// amount was not recorded rather than drawing it as a zero, and ranks its
// items with rankInOneCurrency, because two currencies share no scale.
import { useLocale } from "next-intl";
import { Bar, BarChart, LabelList, XAxis, YAxis } from "recharts";
import {
  byMicrosDescending,
  type Money,
  ratioOfMicros,
} from "@/data/contracts/money";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  chartAxis,
} from "@/ui/chart";
import { formatMoney, type MoneyPrecision } from "@/ui/money-format";

/** One ranked key and its amount. */
export type RankedSpendItem = { key: string; value: Money };

type RankedRow = { key: string; ratio: number; money: string };

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

/** The height of one bar's row, and the bar within it (dataviz: 24px at most). */
const ROW_HEIGHT = 32;
const BAR_SIZE = 20;
/** Keys past this many characters end in an ellipsis; the tooltip shows the whole key. */
const KEY_CHARS = 18;

function shortKey(key: string): string {
  return key.length > KEY_CHARS ? `${key.slice(0, KEY_CHARS - 1)}…` : key;
}

function moneyOf(row: unknown): string | null {
  return typeof row === "object" &&
    row !== null &&
    "money" in row &&
    typeof row.money === "string"
    ? row.money
    : null;
}

export function RankedSpendChart({
  items,
  label,
  seriesLabel,
  precision,
}: {
  /** From rankInOneCurrency; the first item sets the full-length bar. */
  items: readonly RankedSpendItem[];
  /** The chart's accessible name, already translated. */
  label: string;
  /** The measure the bars show, already translated. */
  seriesLabel: string;
  precision: MoneyPrecision;
}) {
  const locale = useLocale();
  const peak = items[0]?.value ?? null;
  // An item in another currency than the peak's has no bar length, so it is
  // left out rather than drawn as zero. rankInOneCurrency already did that, so
  // the one null left is a zero peak, where every bar is zero-length anyway.
  const rows: RankedRow[] = items.flatMap(({ key, value }) =>
    peak === null || value.currency !== peak.currency
      ? []
      : [
          {
            key,
            ratio: ratioOfMicros(value, peak) ?? 0,
            money: formatMoney(value, { locale, precision }),
          },
        ],
  );
  const config: ChartConfig = {
    ratio: { label: seriesLabel, color: "var(--chart-1)" },
  };
  const height = rows.length * ROW_HEIGHT + 8;
  return (
    <div className="px-4 py-3.5">
      <div style={{ height }}>
        <ChartContainer
          config={config}
          label={label}
          className="h-full w-full"
          initialDimension={{ width: 320, height }}
        >
          <BarChart
            data={rows}
            layout="vertical"
            accessibilityLayer={false}
            margin={{ top: 0, right: 72, bottom: 0, left: 0 }}
          >
            <XAxis type="number" domain={[0, 1]} hide />
            <YAxis
              type="category"
              dataKey="key"
              width={128}
              tickFormatter={shortKey}
              {...chartAxis}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  formatValue={(_ratio, _key, row) => moneyOf(row)}
                />
              }
            />
            <Bar
              dataKey="ratio"
              fill="var(--color-ratio)"
              radius={[0, 4, 4, 0]}
              barSize={BAR_SIZE}
            >
              <LabelList
                dataKey="money"
                position="right"
                offset={8}
                className="fill-foreground font-mono"
              />
            </Bar>
          </BarChart>
        </ChartContainer>
      </div>
    </div>
  );
}
