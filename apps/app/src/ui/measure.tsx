// A measured figure as text: money through <Money>, a count through
// formatWholeUnits with its unit (INV-09). A mandate's limits and its ledger
// both speak in measures, so one component prints them wherever they appear.
import { useLocale, useTranslations } from "next-intl";
import type { MeasureValue } from "@/data/contracts/mandates";
import { Money } from "./money";
import { formatMoney, formatWholeUnits } from "./money-format";

export function Measure({ value }: { value: MeasureValue }) {
  const t = useTranslations("ui.measure");
  const locale = useLocale();
  if (value.kind === "money") return <Money value={value.money} />;
  return (
    <span data-testid="measure-count" className="tabular-nums">
      {t("count", {
        count: formatWholeUnits(value.count, locale),
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
          count: formatWholeUnits(value.count, locale),
          unit: value.unit,
        });
}

/**
 * A measured figure with the measure it belongs to. This is the only form a
 * figure takes in a list of them, and the name is never conditional: two
 * measures in one currency are two identical-looking figures, and a lone one is
 * self-explanatory only when it happens to be the expected measure — a single
 * `tax` limit under a column headed *Per call* is an unlabelled dollar figure
 * with nothing on the row to say which budget it governs. The name travels with
 * the value so that no caller decides to omit it and no later caller inherits
 * the omission.
 */
export function NamedMeasure({
  measure,
  value,
}: {
  measure: string;
  value: MeasureValue;
}) {
  return (
    <>
      <Measure value={value} />
      <span className="ml-1 text-xs text-muted-foreground">{measure}</span>
    </>
  );
}
