// A measured figure as text: money through <Money>, a count through
// formatCount with its unit (INV-09). A mandate's limits and its ledger both
// speak in measures, so one component prints them wherever they appear.
import { useLocale, useTranslations } from "next-intl";
import type { MeasureValue } from "@/data/contracts/mandates";
import { Money } from "./money";
import { formatCount, formatMoney } from "./money-format";

export function Measure({ value }: { value: MeasureValue }) {
  const t = useTranslations("ui.measure");
  const locale = useLocale();
  if (value.kind === "money") return <Money value={value.money} />;
  return (
    <span data-testid="measure-count" className="tabular-nums">
      {t("count", {
        count: formatCount(value.count, locale),
        unit: value.unit,
      })}
    </span>
  );
}

/** The same figure as one string, for the label a meter carries. */
export function useMeasureText(): (value: MeasureValue) => string {
  const t = useTranslations("ui.measure");
  const locale = useLocale();
  return (value) =>
    value.kind === "money"
      ? formatMoney(value.money, { locale, precision: "cents" })
      : t("count", {
          count: formatCount(value.count, locale),
          unit: value.unit,
        });
}
