// The cost-center level of the rollup (ADR-142): one row per label and one
// for the spend no cost center claims, each with its share of the month's
// spend. Every run lands on exactly one row, so the rows sum to the strip's
// total and the unlabelled share is a row a reader can see.
import { useLocale, useTranslations } from "next-intl";
import {
  type SpendFigure,
  type SpendReport,
  UNASSIGNED_COST_CENTER_KEY,
} from "@/data/contracts/spend";
import { ratioOfMicros } from "@/data/contracts/money";
import { mono } from "@/ui/control-styles";
import { formatRatio } from "@/ui/money-format";
import { CostFigure, CountFigure, NotRecordedValue } from "./figures";
import { Empty, HeaderCell, Panel } from "./tables";

const cell = "px-4 py-2 text-left align-top";

/**
 * A row's share of the total's spend; null when either side was not priced.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function shareOf(row: SpendFigure, total: SpendFigure): number | null {
  if (row.cost === null || total.cost === null) return null;
  return ratioOfMicros(row.cost, total.cost);
}

export function CostCenterTable({ report }: { report: SpendReport }) {
  const t = useTranslations("spend");
  const locale = useLocale();
  return (
    <Panel
      id="spend-cost_center"
      title={t("groups.cost_center.title")}
      note={t("groups.cost_center.note")}
      footer={t("groups.cost_center.shareBasis")}
    >
      {report.rows.length === 0 ? (
        <Empty>{t("groups.cost_center.empty")}</Empty>
      ) : (
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr>
              <HeaderCell>{t("groups.cost_center.key")}</HeaderCell>
              <HeaderCell numeric>{t("columns.runs")}</HeaderCell>
              <HeaderCell numeric>{t("columns.spend")}</HeaderCell>
              <HeaderCell numeric>{t("columns.shareOfSpend")}</HeaderCell>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => {
              const share = shareOf(row, report.total);
              const unassigned = row.key === UNASSIGNED_COST_CENTER_KEY;
              return (
                <tr
                  key={row.key}
                  data-key={row.key}
                  data-unassigned={unassigned ? "true" : undefined}
                >
                  <th
                    scope="row"
                    className={`${cell} max-w-72 break-words font-normal`}
                  >
                    {unassigned ? (
                      <span className="text-muted-foreground">
                        {t("groups.cost_center.unassigned")}
                      </span>
                    ) : (
                      <span className={mono}>{row.key}</span>
                    )}
                  </th>
                  <td
                    className={`${cell} whitespace-nowrap text-right font-mono`}
                  >
                    <CountFigure count={row.runs} />
                  </td>
                  <td className={`${cell} whitespace-nowrap text-right`}>
                    <CostFigure cost={row.cost} />
                  </td>
                  <td
                    className={`${cell} whitespace-nowrap text-right tabular-nums`}
                  >
                    {share === null ? (
                      <NotRecordedValue />
                    ) : (
                      formatRatio(share, locale)
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
