// One column of a mandate's authority (#2957): the figure each limited measure
// carries under a heading, and — for the per-period limit — the accounting
// window it is counted over.
//
// Shared for the reason the scope is. A mandate's authority is a list of
// measures, and every surface that tabulates it has to answer the same three
// questions: which measures have a figure in this column, what is shown when
// none do, and which window the figure belongs to. The Tools ledger and the
// Agents table each answered them in a local component, and each local answer
// dropped `period` and `periodKey` — so a daily limit of 100 and a monthly one
// rendered identically on both pages, twice over. One implementation is the
// fix; a third table gets it right without knowing the question was asked.
//
// The window is named once per measure, on the per-period limit it resets
// against, rather than repeated on every windowed figure. `settled`, `reserved`
// and `remaining` are counted over that same window and are tied to it by the
// measure they name — and the view model guarantees the tie: a measure with no
// per-period limit has no remaining and no ratios (INV-10), so there is no
// windowed figure without a per-period limit beside it to carry the window.
import { useTranslations } from "next-intl";
import type { MandateAuthority, MeasureValue } from "@/data/contracts/mandates";
import { NamedMeasure } from "./measure";

export function MandateAuthorityList({
  authority,
  pick,
  window: showWindow = false,
}: {
  authority: readonly MandateAuthority[];
  /** The figure this column shows, or null where the measure has none. */
  pick: (of: MandateAuthority) => MeasureValue | null;
  /**
   * Names the accounting window each figure belongs to. A daily 100 and a
   * monthly 100 are different authorities and render the same without it, and
   * a balance means nothing until the reader knows when it resets. Each
   * measure carries its own — a mandate may cap calls daily and money monthly
   * — so the window sits with the limit it qualifies, not once per row.
   */
  window?: boolean;
}) {
  const t = useTranslations("ui.mandateAuthority");
  const values = authority
    .map((measure) => ({
      measure: measure.measure,
      period: measure.period,
      periodKey: measure.periodKey,
      value: pick(measure),
    }))
    .filter(
      (
        entry,
      ): entry is typeof entry & { value: NonNullable<typeof entry.value> } =>
        entry.value !== null,
    );
  // An empty cell is ambiguous between "no limit" and "not shown". The column
  // says which.
  if (values.length === 0)
    return <span className="text-muted-foreground">{t("noLimit")}</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {values.map((entry) => (
        <li key={entry.measure}>
          {/* The name is never conditional: a lone `tax` limit under a column
              headed Per call is otherwise an unlabelled dollar figure. */}
          <NamedMeasure measure={entry.measure} value={entry.value} />
          {showWindow ? (
            <div
              data-window={entry.period}
              className="text-xs text-muted-foreground"
            >
              {t("window", {
                period: t(`period.${entry.period}`),
                periodKey: entry.periodKey,
              })}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
