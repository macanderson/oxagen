"use client";
// By tool's chart (spec "By tool"): one chart at a time under a three-button
// switcher, Cumulative spend, Avg per run and Avg per call, in that order. It
// holds the leading twelve tools by the metric shown; the table beside it
// holds every one. The bars come from the chart kit through RankedSpendChart.
// A bar's length is layout and never a printed figure; the money at its end
// is. A tool whose metric was not recorded is left out of the chart rather
// than drawn as a zero, and so is a tool billed in another currency than the
// chart's, which the footer counts.
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import type { Money as MoneyValue } from "@/data/contracts/money";
import {
  panel,
  panelFooter,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { rankInOneCurrency } from "./rank-in-one-currency";
import { RankedSpendChart } from "./ranked-spend-chart";

const METRICS = ["cumulative", "perRun", "perCall"] as const;
type Metric = (typeof METRICS)[number];

/** How many tools the chart holds. */
const CHART_MAX = 12;

export type ToolChartItem = {
  key: string;
  cumulative: MoneyValue | null;
  perRun: MoneyValue | null;
  perCall: MoneyValue | null;
};

export function ToolChart({ tools }: { tools: readonly ToolChartItem[] }) {
  const t = useTranslations("spend.toolChart");
  const locale = useLocale();
  const [metric, setMetric] = useState<Metric>("cumulative");
  const { ranked, otherCurrency } = rankInOneCurrency(
    tools.flatMap((tool) => {
      const value = tool[metric];
      return value === null ? [] : [{ key: tool.key, value }];
    }),
  );
  const shown = ranked.slice(0, CHART_MAX);
  return (
    <section
      aria-labelledby="spend-tool-chart"
      data-testid="spend-tool-chart"
      className={panel}
    >
      <div className={`${panelHeader} flex-col items-stretch`}>
        <h2 id="spend-tool-chart" className={panelTitle}>
          {t(`metric.${metric}`)}
        </h2>
        <div
          role="group"
          aria-label={t("switcher")}
          className="flex flex-wrap gap-1"
        >
          {METRICS.map((choice) => (
            <button
              key={choice}
              type="button"
              data-touch-target=""
              aria-pressed={choice === metric}
              onClick={() => {
                setMetric(choice);
              }}
              className="rounded-md border border-transparent px-2.5 py-1 text-sm text-muted-foreground hover:text-foreground aria-pressed:border-border aria-pressed:bg-card aria-pressed:text-foreground"
            >
              {t(`metric.${choice}`)}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="px-4 py-3.5 text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <RankedSpendChart
          items={shown}
          label={t("label", { metric: t(`metric.${metric}`) })}
          seriesLabel={t(`metric.${metric}`)}
          precision={metric === "cumulative" ? "cents" : "exact"}
        />
      )}
      <p className={panelFooter}>
        {t("footer", {
          shown: formatCount(shown.length, locale),
          total: formatCount(tools.length, locale),
        })}
        {otherCurrency > 0
          ? ` ${t("otherCurrency", { count: otherCurrency })}`
          : null}
      </p>
    </section>
  );
}
