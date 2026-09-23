"use client";
// By tool's chart (spec "By tool"): one chart at a time under a three-button
// switcher, Cumulative spend, Avg per run and Avg per call, in that order. It
// holds the leading twelve tools by the metric shown; the table beside it
// holds every one. A bar's width is layout and never a printed figure; the
// money beside it is. A tool whose metric was not recorded is left out of the
// chart rather than drawn as a zero.
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import {
  byMicrosDescending,
  type Money as MoneyValue,
  ratioOfMicros,
} from "@/data/contracts/money";
import {
  mono,
  panel,
  panelFooter,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount, ratioWidth } from "@/ui/money-format";

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
  const ranked = tools
    .flatMap((tool) => {
      const value = tool[metric];
      return value === null ? [] : [{ key: tool.key, value }];
    })
    .sort((a, b) => byMicrosDescending(a.value, b.value));
  const shown = ranked.slice(0, CHART_MAX);
  const peak = shown[0]?.value ?? null;
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
              className="rounded-md border border-transparent px-2.5 py-1 text-[12.5px] text-muted-foreground hover:text-foreground aria-pressed:border-border aria-pressed:bg-card aria-pressed:text-foreground"
            >
              {t(`metric.${choice}`)}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="px-4 py-3.5 text-[12.5px] text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <div
          role="img"
          aria-label={t("label", { metric: t(`metric.${metric}`) })}
          className="flex flex-col gap-2.5 px-4 py-3.5"
        >
          {shown.map(({ key, value }) => {
            const ratio = peak === null ? null : ratioOfMicros(value, peak);
            return (
              <div key={key} data-key={key} className="flex flex-col gap-1">
                <span className="flex items-baseline justify-between gap-2 text-[12px]">
                  <span className={`${mono} min-w-0 truncate`}>{key}</span>
                  <span className="font-semibold">
                    <Money
                      value={value}
                      precision={metric === "cumulative" ? "cents" : "exact"}
                    />
                  </span>
                </span>
                <span className="block h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full bg-gold"
                    style={{ width: ratioWidth(ratio ?? 0) }}
                  />
                </span>
              </div>
            );
          })}
        </div>
      )}
      <p className={panelFooter}>
        {t("footer", {
          shown: formatCount(shown.length, locale),
          total: formatCount(tools.length, locale),
        })}
      </p>
    </section>
  );
}
