"use client";
// Spend by day in a drill: an area over the window, drawn with the chart kit
// (@/ui/chart). It answers when the key's spend rose and fell. The height of
// each day is its share of the window's peak, a float from ratioOfMicros
// (INV-09), so the chart carries no value axis. The exact money of a day is in
// its tooltip and in the table under the chart, and the panel footer prints
// the peak and the average. A day with no priced run is a gap in the line and
// reads "not recorded", never a zero.
import { useLocale, useTranslations } from "next-intl";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { type Money, ratioOfMicros } from "@/data/contracts/money";
import {
  type ChartConfig,
  ChartContainer,
  ChartTable,
  ChartTooltip,
  ChartTooltipContent,
  chartAxis,
  chartCrosshair,
  chartGrid,
} from "@/ui/chart";
import { formatMoney } from "@/ui/money-format";
import { NotRecordedValue } from "./figures";

type DayRow = { day: string; ratio: number | null; money: string | null };

function moneyOf(row: unknown): string | null {
  return typeof row === "object" &&
    row !== null &&
    "money" in row &&
    typeof row.money === "string"
    ? row.money
    : null;
}

export function SpendByDayChart({
  series,
  peak,
  label,
}: {
  /** One entry per day of the window, oldest first. */
  series: readonly { day: string; cost: Money | null }[];
  /** The window's largest day, which sets the full height. */
  peak: Money;
  /** The chart's accessible name, already translated. */
  label: string;
}) {
  const t = useTranslations("spend.drill");
  const locale = useLocale();
  const rows: DayRow[] = series.map(({ day, cost }) => ({
    day,
    // A recorded day over a zero peak is a recorded zero, so it sits on the
    // baseline; only an unrecorded day is a gap.
    ratio: cost === null ? null : (ratioOfMicros(cost, peak) ?? 0),
    money:
      cost === null ? null : formatMoney(cost, { locale, precision: "cents" }),
  }));
  const config: ChartConfig = {
    ratio: { label: t("byDay"), color: "var(--chart-1)" },
  };
  // Only the window's first and last days are labelled; the tooltip and the
  // table name every day.
  const ticks = [...new Set([rows[0]?.day, rows.at(-1)?.day])].filter(
    (day) => day !== undefined,
  );
  return (
    <>
      <div className="px-4 pt-3.5 pb-1">
        <ChartContainer
          config={config}
          label={label}
          className="h-32 w-full"
          initialDimension={{ width: 320, height: 128 }}
        >
          <AreaChart
            data={rows}
            accessibilityLayer={false}
            margin={{ top: 4, right: 4, bottom: 0, left: 4 }}
          >
            <CartesianGrid {...chartGrid} />
            <XAxis dataKey="day" ticks={ticks} interval={0} {...chartAxis} />
            <YAxis type="number" domain={[0, 1]} hide />
            <ChartTooltip
              cursor={chartCrosshair}
              content={
                <ChartTooltipContent
                  formatValue={(_ratio, _key, row) => moneyOf(row)}
                />
              }
            />
            <Area
              dataKey="ratio"
              type="monotone"
              stroke="var(--color-ratio)"
              strokeWidth={2}
              fill="var(--color-ratio)"
              fillOpacity={0.1}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
            />
          </AreaChart>
        </ChartContainer>
      </div>
      <ChartTable
        label={label}
        columns={[{ label: t("day") }, { label: t("spend"), numeric: true }]}
        rows={rows.map((row) => ({
          key: row.day,
          cells: [
            row.day,
            row.money === null ? (
              <NotRecordedValue />
            ) : (
              <span className="font-mono">{row.money}</span>
            ),
          ],
        }))}
      />
    </>
  );
}
