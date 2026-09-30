// The Spend tables the Month tab does not replace (#2962; spec "By tool",
// "Budgets"): By tool, By task, and Budgets, with the panel they share. A tool
// row opens that key's drill; a task row has none. Every money cell carries
// its basis; a column the rollup does not record prints "not recorded", never
// a zero. Potential savings are the sum of the open findings that name the
// key, from list_findings. On a phone the shell labels each cell with its
// column (card tables), so each table keeps a single header row.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { divMicros, ratioOfMicros } from "@/data/contracts/money";
import type {
  SpendBudgets,
  SpendDrillKind,
  SpendFinding,
  SpendReport,
} from "@/data/contracts/spend";
import { routes } from "@/shared/safe-path";
import {
  linkText,
  mono,
  panel,
  panelFooter,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount, formatRatio, ratioWidth } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { cell, numericCell, Table } from "@/ui/table";
import { BudgetDialog } from "./budget-dialog";
import { CostFigure, NotRecordedValue } from "./figures";
import { NotBacked } from "./not-backed";
import { findingsOn, savingOf } from "./rollup";
import { ToolChart } from "./tool-chart";
import type { SpendAt } from "./view";

export function Panel({
  id,
  title,
  note,
  action,
  footer,
  children,
}: {
  id: string;
  title: string;
  /** A line under the heading saying what the panel covers. */
  note?: string;
  /** A control that belongs to the panel as a whole, beside its heading. */
  action?: ReactNode;
  /** Existing explanatory or dated metadata below the data. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className={panel}>
      <div className={panelHeader}>
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={id} className={panelTitle}>
            {title}
          </h2>
          {note === undefined ? null : (
            <p className="text-xs text-muted-foreground">{note}</p>
          )}
        </div>
        {action}
      </div>
      {children}
      {footer === undefined ? null : (
        <div className={panelFooter}>{footer}</div>
      )}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="p-4 text-sm text-muted-foreground">{children}</p>;
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
      className={`px-4 py-2 text-left align-top font-medium text-muted-foreground ${numeric ? "text-right" : ""}`}
    >
      {children}
    </th>
  );
}

/** The key's open findings: what they have at stake and how many there are. */
function Savings({
  findings,
  level,
  keyOf,
}: {
  findings: readonly SpendFinding[] | null;
  level: SpendDrillKind;
  keyOf: string;
}) {
  const t = useTranslations("spend.columns");
  const locale = useLocale();
  if (findings === null) return <NotRecordedValue />;
  const own = findingsOn(findings, level, keyOf);
  const saving = savingOf(own);
  if (saving === null) {
    return <span className="text-muted-foreground">{t("noFinding")}</span>;
  }
  return (
    <span className="flex flex-col items-end gap-0.5">
      <span className="max-w-full text-link md:truncate">
        <Money value={saving} />
      </span>
      <span className="max-w-full font-sans text-[11px] text-muted-foreground md:truncate">
        {t("findings", {
          count: own.length,
          n: formatCount(own.length, locale),
        })}
      </span>
    </span>
  );
}

function DrillLink({
  at,
  kind,
  keyOf,
  children,
}: {
  at: SpendAt;
  kind: SpendDrillKind;
  keyOf: string;
  children: ReactNode;
}) {
  return (
    <SafeLink
      to={routes.spend(at.org, at.ws, { tab: kind, drill: keyOf })}
      className={linkText}
    >
      {children}
    </SafeLink>
  );
}

/** The tool rollup: the table in two thirds, the chart in the last third. */
export function ToolSection({
  report,
  findings,
  at,
}: {
  report: SpendReport;
  findings: readonly SpendFinding[] | null;
  at: SpendAt;
}) {
  const t = useTranslations("spend");
  const locale = useLocale();
  const total = report.total.cost;
  const rows = report.rows.map((row) => ({
    row,
    share:
      row.cost === null || total === null
        ? null
        : ratioOfMicros(row.cost, total),
    perCall: row.cost === null ? null : divMicros(row.cost, row.calls),
    perRun: row.cost === null ? null : divMicros(row.cost, row.runs),
  }));
  return (
    <div className="grid items-start gap-3.5 lg:grid-cols-3">
      <div className="min-w-0 lg:col-span-2">
        <Panel
          id="spend-tool"
          title={t("groups.tool.title")}
          footer={
            <span className="flex flex-col gap-2">
              <span>{t("groups.tool.note")}</span>
              <NotBacked gap="findings">
                {t("groups.tool.framesMissing")}
              </NotBacked>
            </span>
          }
        >
          {report.rows.length === 0 ? (
            <Empty>{t("groups.tool.empty")}</Empty>
          ) : (
            <Table
              label={t("groups.tool.title")}
              columns={[
                { label: t("columns.tool") },
                { label: t("columns.server") },
                { label: t("columns.calls"), numeric: true },
                { label: t("columns.runs"), numeric: true },
                { label: t("columns.cumulative"), numeric: true },
                { label: t("columns.share"), numeric: true },
                { label: t("columns.perCall"), numeric: true },
                { label: t("columns.perRunMoney"), numeric: true },
                { label: t("columns.savings"), numeric: true },
                { label: t("columns.frames") },
              ]}
            >
              {rows.map(({ row, share, perCall, perRun: run }) => (
                <tr key={row.key} data-key={row.key}>
                  <th scope="row" className={`${cell} text-left font-normal`}>
                    <DrillLink at={at} kind="tool" keyOf={row.key}>
                      <span className={mono}>{row.key}</span>
                    </DrillLink>
                  </th>
                  <td className={cell}>
                    <NotRecordedValue />
                  </td>
                  <td className={numericCell}>
                    {formatCount(row.calls, locale)}
                  </td>
                  <td className={numericCell}>
                    {formatCount(row.runs, locale)}
                  </td>
                  <td className={numericCell}>
                    <CostFigure cost={row.cost} />
                  </td>
                  <td className={numericCell}>
                    {share === null ? (
                      <NotRecordedValue />
                    ) : (
                      formatRatio(share, locale)
                    )}
                  </td>
                  <td className={numericCell}>
                    {perCall === null ? (
                      <NotRecordedValue />
                    ) : (
                      <Money value={perCall} precision="exact" />
                    )}
                  </td>
                  <td className={numericCell}>
                    {run === null ? (
                      <NotRecordedValue />
                    ) : (
                      <Money value={run} precision="exact" />
                    )}
                  </td>
                  <td className={numericCell}>
                    <Savings findings={findings} level="tool" keyOf={row.key} />
                  </td>
                  <td className={cell}>
                    <NotRecordedValue />
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>
      <ToolChart
        tools={rows.map(({ row, perCall, perRun: run }) => ({
          key: row.key,
          cumulative: row.cost,
          perRun: run,
          perCall,
        }))}
      />
    </div>
  );
}

/** By task (this build's own tab): the run's goal text, with no drill. */
export function TaskTable({ report }: { report: SpendReport }) {
  const t = useTranslations("spend");
  const locale = useLocale();
  return (
    <Panel id="spend-task" title={t("groups.task.title")}>
      {report.rows.length === 0 ? (
        <Empty>{t("groups.task.empty")}</Empty>
      ) : (
        <Table
          label={t("groups.task.title")}
          columns={[
            { label: t("groups.task.key") },
            { label: t("columns.runs"), numeric: true },
            { label: t("columns.calls"), numeric: true },
            { label: t("columns.spend"), numeric: true },
          ]}
        >
          {report.rows.map((row) => (
            <tr key={row.key} data-key={row.key}>
              <th scope="row" className={`${cell} text-left font-normal`}>
                {row.key}
              </th>
              <td className={numericCell}>{formatCount(row.runs, locale)}</td>
              <td className={numericCell}>{formatCount(row.calls, locale)}</td>
              <td className={numericCell}>
                <CostFigure cost={row.cost} />
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

export function BudgetsTable({
  budgets,
  at,
}: {
  budgets: SpendBudgets;
  at: SpendAt;
}) {
  const t = useTranslations("spend");
  const locale = useLocale();
  return (
    <Panel
      id="spend-budgets"
      title={t("budgets.title")}
      action={<BudgetDialog at={at} placement="panel" />}
      footer={
        <span className="flex flex-col gap-2">
          <span>{t("budgets.note")}</span>
          <NotBacked gap="budgets">{t("budgets.scopesMissing")}</NotBacked>
        </span>
      }
    >
      {budgets.length === 0 ? (
        <Empty>{t("budgets.empty")}</Empty>
      ) : (
        <Table
          label={t("budgets.title")}
          columns={[
            { label: t("budgets.scopeColumn") },
            { label: t("budgets.periodColumn") },
            { label: t("budgets.limitColumn"), numeric: true },
            { label: t("budgets.usedColumn"), numeric: true },
            { label: t("budgets.modeColumn") },
            { label: t("budgets.positionColumn") },
          ]}
        >
          {budgets.map((budget) => (
            <tr key={budget.scope} data-scope={budget.scope}>
              <th
                scope="row"
                className={`${cell} text-left font-mono font-normal`}
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
              <td className={numericCell}>
                {budget.limit === null ? (
                  t("budgets.noLimit")
                ) : (
                  <Money value={budget.limit} />
                )}
              </td>
              <td className={numericCell}>
                <Money value={budget.spent} />
              </td>
              <td className={cell}>
                <span
                  data-mode={budget.enabled ? "hard" : "off"}
                  className="inline-flex items-center gap-1.5 text-[12px]"
                >
                  <span
                    aria-hidden="true"
                    className={`size-1.5 rounded-full ${budget.enabled ? "bg-destructive" : "bg-muted-foreground"}`}
                  />
                  {budget.enabled ? t("budgets.hard") : t("budgets.disabled")}
                </span>
              </td>
              <td className={`${cell} min-w-40`} data-state={budget.state}>
                {budget.limit === null ? (
                  t("budgets.noLimit")
                ) : (
                  <span className="flex flex-col gap-1">
                    <span
                      role="img"
                      aria-label={t("budgets.positionLabel", {
                        ratio: formatRatio(budget.ratio, locale),
                      })}
                      className="block h-1.5 w-full overflow-hidden rounded-full bg-muted"
                    >
                      <span
                        className={`block h-full ${budget.ratio > 0.8 ? "bg-destructive" : "bg-success"}`}
                        style={{ width: ratioWidth(budget.ratio) }}
                      />
                    </span>
                    <span className="text-[11px] text-muted-foreground md:truncate">
                      {t("budgets.position", {
                        ratio: formatRatio(budget.ratio, locale),
                        state: t(`budgets.state.${budget.state}`),
                      })}
                    </span>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}
