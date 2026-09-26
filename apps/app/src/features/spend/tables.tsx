// The rollup at one level, as the design's tables (#2962; spec "By operator",
// "By agent", "By model", "By tool", "Budgets"). An operator, agent or tool row
// opens that key's drill; a model or task row has none. Every money cell
// carries its basis; a column the rollup does not record prints "not
// recorded", never a zero. Potential savings are the sum of the open findings
// that name the key, from list_findings. On a phone the shell labels each cell
// with its column (card tables), so each table keeps a single header row.
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
  buttonSecondary,
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
import { OperatorName } from "@/ui/operator";
import { cell, numericCell, Table } from "@/ui/table";
import { BudgetDialog } from "./budget-dialog";
import {
  BasisLabel,
  CostFigure,
  NotRecordedValue,
  UnmeteredNote,
} from "./figures";
import { NotBacked } from "./not-backed";
import {
  cacheHitRate,
  classesOf,
  findingsOn,
  perRun,
  savingOf,
  totalOf,
} from "./rollup";
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

type Row = SpendReport["rows"][number];

function Tokens({ row }: { row: Row }) {
  const locale = useLocale();
  return <>{formatCount(totalOf(classesOf(row.tokens)), locale)}</>;
}

function CacheHit({ row }: { row: Row }) {
  const locale = useLocale();
  const rate = cacheHitRate(classesOf(row.tokens));
  return rate === null ? (
    <NotRecordedValue />
  ) : (
    <>{formatRatio(rate, locale)}</>
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
      <span className="text-link">
        <Money value={saving} />
      </span>
      <span className="font-sans text-[11px] text-muted-foreground">
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

export function OperatorTable({
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
  return (
    <Panel
      id="spend-operator"
      title={t("groups.operator.title")}
      footer={
        <span className="flex flex-col gap-2">
          <span>{t("groups.operator.note")}</span>
          <NotBacked gap="budgets">
            {t("groups.operator.budgetMissing")}
          </NotBacked>
        </span>
      }
    >
      {report.rows.length === 0 ? (
        <Empty>{t("groups.operator.empty")}</Empty>
      ) : (
        <Table
          label={t("groups.operator.title")}
          columns={[
            { label: t("columns.operator") },
            { label: t("columns.role") },
            { label: t("columns.agents"), numeric: true },
            { label: t("columns.runs"), numeric: true },
            { label: t("columns.spend"), numeric: true },
            { label: t("columns.tokens"), numeric: true },
            { label: t("columns.cacheHit"), numeric: true },
            { label: t("columns.savings"), numeric: true },
            { label: t("columns.budgetPosition") },
          ]}
        >
          {report.rows.map((row) => (
            <tr key={row.key} data-key={row.key}>
              <th scope="row" className={`${cell} text-left font-semibold`}>
                {/* The person, by name. The id is the drill route's key and the
                    hover card holds it; it is never the label. */}
                <OperatorName
                  operator={{
                    id: row.key,
                    name: row.operator?.name ?? null,
                    kind: "human",
                    email: row.operator?.email ?? null,
                    avatarUrl: row.operator?.avatarUrl ?? null,
                    role: row.operator?.role ?? null,
                  }}
                >
                  <DrillLink at={at} kind="operator" keyOf={row.key}>
                    {row.operator?.name ?? t("groups.operator.unnamed")}
                  </DrillLink>
                </OperatorName>
              </th>
              <td
                className={`${cell} ${mono} text-[11.5px] text-muted-foreground`}
              >
                {row.operator?.role ?? <NotRecordedValue />}
              </td>
              <td className={numericCell}>
                <NotRecordedValue />
              </td>
              <td className={numericCell}>{formatCount(row.runs, locale)}</td>
              <td className={numericCell}>
                <CostFigure cost={row.cost} />
              </td>
              <td className={numericCell}>
                <Tokens row={row} />
              </td>
              <td className={numericCell}>
                <CacheHit row={row} />
              </td>
              <td className={numericCell}>
                <Savings findings={findings} level="operator" keyOf={row.key} />
              </td>
              <td className={cell}>
                <NotRecordedValue />
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

export function AgentTable({
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
  return (
    <Panel
      id="spend-agent"
      title={t("groups.agent.title")}
      footer={
        <span className="flex flex-col gap-2">
          <span>{t("groups.agent.note")}</span>
          <NotBacked gap="rollup">{t("groups.agent.trendMissing")}</NotBacked>
        </span>
      }
    >
      {report.rows.length === 0 ? (
        <Empty>{t("groups.agent.empty")}</Empty>
      ) : (
        <Table
          label={t("groups.agent.title")}
          columns={[
            { label: t("columns.agent") },
            { label: t("columns.runs"), numeric: true },
            { label: t("columns.spend"), numeric: true },
            { label: t("columns.tokens"), numeric: true },
            { label: t("columns.perRun"), numeric: true },
            { label: t("columns.cacheHit"), numeric: true },
            { label: t("columns.savings"), numeric: true },
            { label: t("columns.trend") },
          ]}
        >
          {report.rows.map((row) => {
            const per = perRun(totalOf(classesOf(row.tokens)), row.runs);
            return (
              <tr key={row.key} data-key={row.key}>
                <th scope="row" className={`${cell} text-left font-normal`}>
                  <DrillLink at={at} kind="agent" keyOf={row.key}>
                    <span className={`${mono} break-all`}>{row.key}</span>
                  </DrillLink>
                </th>
                <td className={numericCell}>{formatCount(row.runs, locale)}</td>
                <td className={numericCell}>
                  <CostFigure cost={row.cost} />
                </td>
                <td className={numericCell}>
                  <Tokens row={row} />
                </td>
                <td className={numericCell}>
                  {per === null ? (
                    <NotRecordedValue />
                  ) : (
                    formatCount(per, locale)
                  )}
                </td>
                <td className={numericCell}>
                  <CacheHit row={row} />
                </td>
                <td className={numericCell}>
                  <Savings findings={findings} level="agent" keyOf={row.key} />
                </td>
                <td className={cell}>
                  <NotRecordedValue />
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </Panel>
  );
}

export function ModelTable({ month, at }: { month: SpendReport; at: SpendAt }) {
  const t = useTranslations("spend");
  const locale = useLocale();
  return (
    <Panel
      id="spend-model"
      title={t("groups.model.title")}
      note={t("groups.model.note")}
      action={
        <SafeLink to={routes.modelFunding(at.org)} className={buttonSecondary}>
          {t("groups.model.routes")}
        </SafeLink>
      }
      footer={
        <span className="flex flex-col gap-2">
          <span>{t("groups.model.footer")}</span>
          <NotBacked gap="rollup">{t("groups.model.keyMissing")}</NotBacked>
        </span>
      }
    >
      <Table
        label={t("groups.model.title")}
        columns={[
          { label: t("columns.model") },
          { label: t("columns.providerKey") },
          { label: t("columns.modelCalls"), numeric: true },
          { label: t("columns.spend"), numeric: true },
          { label: t("columns.cacheHitRate"), numeric: true },
          { label: t("columns.basis") },
        ]}
      >
        {month.rows.map((row) => (
          <tr key={row.key} data-key={row.key}>
            <th
              scope="row"
              className={`${cell} text-left font-mono font-normal`}
            >
              {row.key}
            </th>
            <td className={cell}>
              <span className="flex flex-col">
                <NotRecordedValue />
                {row.provider === null ? null : (
                  <span className="text-[11px] text-muted-foreground">
                    {row.provider}
                  </span>
                )}
              </span>
            </td>
            <td className={numericCell}>{formatCount(row.calls, locale)}</td>
            <td className={numericCell}>
              {row.cost === null ? (
                <NotRecordedValue />
              ) : (
                <Money value={row.cost} />
              )}
            </td>
            <td className={numericCell}>
              <CacheHit row={row} />
            </td>
            <td className={cell}>
              <BasisLabel basis={row.cost?.basis ?? null} />
            </td>
          </tr>
        ))}
        <tr data-total="">
          <th scope="row" className={`${cell} text-left`} colSpan={3}>
            <span className="font-semibold">{t("groups.model.total")}</span>{" "}
            <span className="text-[11.5px] font-normal text-muted-foreground">
              {t("groups.model.totalNote")}
            </span>
            <UnmeteredNote
              unmetered={month.unmeteredRuns}
              className="block text-[11.5px] font-normal text-muted-foreground"
              testId="spend-model-unmetered"
            />
          </th>
          <td className={`${numericCell} font-semibold`}>
            {month.total.cost === null ? (
              <NotRecordedValue />
            ) : (
              <Money value={month.total.cost} />
            )}
          </td>
          <td className={cell} />
          <td className={cell}>
            <BasisLabel basis={month.total.cost?.basis ?? null} />
          </td>
        </tr>
      </Table>
    </Panel>
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
                      <span className={`${mono} break-all`}>{row.key}</span>
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
                    <span className="text-[11px] text-muted-foreground">
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
