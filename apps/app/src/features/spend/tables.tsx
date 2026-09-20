// The rollup at one level and the configured ceilings, as tables (#2962). An
// operator, agent or tool row opens that key's drill; a model row has none.
// On a phone the shell labels each cell with its column (card tables).
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  SpendBudgets,
  SpendGroupKind,
  SpendReport,
} from "@/data/contracts/spend";
import { routes } from "@/shared/safe-path";
import { linkText, mono, panel } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount, formatRatio } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { CostFigure, CountFigure, NotRecordedValue } from "./figures";
import type { SpendAt } from "./view";

const cell = "px-4 py-2 text-left align-top";

export function Panel({
  id,
  title,
  note,
  action,
  children,
}: {
  id: string;
  title: string;
  /** A line under the heading saying what the panel covers. */
  note?: string;
  /** A control that belongs to the panel as a whole, beside its heading. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className={`${panel} overflow-x-auto`}>
      <div className="flex flex-wrap items-start justify-between gap-2 px-4 pt-4 pb-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={id} className="text-sm font-semibold">
            {title}
          </h2>
          {note === undefined ? null : (
            <p className="text-xs text-muted-foreground">{note}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 pb-4 text-sm text-muted-foreground">{children}</p>;
}

export function HeaderCell({
  children,
  numeric = false,
}: {
  children: ReactNode;
  numeric?: boolean;
}) {
  return (
    <th
      scope="col"
      className={`${cell} font-medium text-muted-foreground ${numeric ? "text-right" : ""}`}
    >
      {children}
    </th>
  );
}

export function GroupTable({
  kind,
  rows,
  at,
}: {
  kind: SpendGroupKind;
  rows: SpendReport["rows"];
  at: SpendAt;
}) {
  const t = useTranslations("spend");
  return (
    <Panel id={`spend-${kind}`} title={t(`groups.${kind}.title`)}>
      {rows.length === 0 ? (
        <Empty>{t(`groups.${kind}.empty`)}</Empty>
      ) : (
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr>
              <HeaderCell>{t(`groups.${kind}.key`)}</HeaderCell>
              {kind === "model" ? (
                <HeaderCell>{t("columns.provider")}</HeaderCell>
              ) : null}
              <HeaderCell numeric>{t("columns.runs")}</HeaderCell>
              <HeaderCell numeric>{t("columns.calls")}</HeaderCell>
              <HeaderCell numeric>{t("columns.spend")}</HeaderCell>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} data-key={row.key}>
                <th
                  scope="row"
                  className={`${cell} max-w-72 break-words font-normal`}
                >
                  {kind === "model" ? (
                    <span className={mono}>{row.key}</span>
                  ) : (
                    <SafeLink
                      to={routes.spend(at.org, at.ws, {
                        tab: kind,
                        drill: row.key,
                      })}
                      className={`${linkText} ${mono}`}
                    >
                      {row.key}
                    </SafeLink>
                  )}
                </th>
                {kind === "model" ? (
                  <td className={cell}>
                    {row.provider ?? <NotRecordedValue />}
                  </td>
                ) : null}
                <td
                  className={`${cell} whitespace-nowrap text-right font-mono`}
                >
                  <CountFigure count={row.runs} />
                </td>
                <td
                  className={`${cell} whitespace-nowrap text-right font-mono`}
                >
                  <CountFigure count={row.calls} />
                </td>
                <td className={`${cell} whitespace-nowrap text-right`}>
                  <CostFigure cost={row.cost} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

export function BudgetsTable({ budgets }: { budgets: SpendBudgets }) {
  const t = useTranslations("spend");
  const locale = useLocale();
  return (
    <Panel id="spend-budgets" title={t("budgets.title")}>
      {budgets.length === 0 ? (
        <Empty>{t("budgets.empty")}</Empty>
      ) : (
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr>
              <HeaderCell>{t("budgets.scopeColumn")}</HeaderCell>
              <HeaderCell>{t("budgets.periodColumn")}</HeaderCell>
              <HeaderCell>{t("budgets.limitColumn")}</HeaderCell>
              <HeaderCell>{t("budgets.spentColumn")}</HeaderCell>
              <HeaderCell>{t("budgets.positionColumn")}</HeaderCell>
            </tr>
          </thead>
          <tbody>
            {budgets.map((budget) => (
              <tr key={budget.scope} data-scope={budget.scope}>
                <th
                  scope="row"
                  className={`${cell} max-w-72 break-words font-normal`}
                >
                  {t(`budgets.scope.${budget.scope}`)}
                </th>
                <td className={cell}>
                  {budget.period === "monthly" ? (
                    t("budgets.monthly")
                  ) : budget.windowDays === null ? (
                    <NotRecordedValue />
                  ) : (
                    t("budgets.rolling", {
                      days: formatCount(budget.windowDays, locale),
                    })
                  )}
                </td>
                <td className={cell}>
                  {budget.limit === null ? (
                    t("budgets.noLimit")
                  ) : (
                    <Money value={budget.limit} />
                  )}
                </td>
                <td className={cell}>
                  <Money value={budget.spent} />
                </td>
                <td className={cell} data-state={budget.state}>
                  {!budget.enabled
                    ? t("budgets.disabled")
                    : budget.limit === null
                      ? t("budgets.noLimit")
                      : t("budgets.position", {
                          ratio: formatRatio(budget.ratio, locale),
                          state: t(`budgets.state.${budget.state}`),
                        })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
