// A measured figure as text: money through <Money>, a count through
// formatWholeUnits with its unit (INV-09). A mandate's limits and its ledger
// both speak in measures, so one component prints them wherever they appear.
//
// **Money here is printed exact, not to the cent.** A measure is a figure the
// gate enforces, and the gate enforces micros: a per-call limit of 5,000 micros
// is $0.005, and at the cent it read "$0.00" — a real budget rendering as no
// budget, on the page an accountable office reads to review what it granted.
// Worse, every distinct limit under a cent collapsed onto that same "$0.00", so
// four different authorities were one string. Storing exactly and displaying
// lossily defeats the reason INV-09 stores micros as integers at all.
//
// This takes the precision the shared formatter already offers rather than
// adding a second money formatter — two formatters is how two answers to "what
// is this figure" arrive. `exact` keeps a minimum of two fraction digits, so
// $250.00 and $2,000.00 are unchanged; only a figure with something below the
// cent gains digits, and then only as many as it has.
//
// Scope: `Measure`, `NamedMeasure` and `useMeasureText` are used by the mandate
// surfaces alone — the two ledger tables through `MandateAuthorityList`, the
// approval card's per-call measures, and `MandateBar`. `<Money>`'s own default
// is untouched, so billing and spend, where the cent is the unit of account,
// are unaffected.
import { useLocale, useTranslations } from "next-intl";
import type { MeasureValue } from "@/data/contracts/mandates";
import { Money } from "./money";
import { formatMoney, formatWholeUnits } from "./money-format";

export function Measure({ value }: { value: MeasureValue }) {
  const t = useTranslations("ui.measure");
  const locale = useLocale();
  if (value.kind === "money")
    return <Money value={value.money} precision="exact" />;
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
      ? formatMoney(value.money, { locale, precision: "exact" })
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
