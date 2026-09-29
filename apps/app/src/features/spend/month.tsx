// The Month tab (#2962; v3 mockup `spdMonth`, ADR-226): what every run cost
// this month, from its own model requests. The total with the workspace's
// monthly budget beside it, the spend by day, and one table grouped by agent,
// operator, model, or MCP server, each row opening to its costliest runs. One
// get_spend read at the chosen grouping carries all of it. The design's Budget
// column is not drawn: a budget holds for the organization or the workspace,
// never one agent or one operator (#3864).
import { useLocale, useTranslations } from "next-intl";
import {
  maxMoney,
  type Money as MoneyValue,
  ratioOfMicros,
} from "@/data/contracts/money";
import {
  OTHER_SPEND_KEY,
  type SpendBudgets,
  type SpendReport,
  type SpendTopRun,
} from "@/data/contracts/spend";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { Avatar } from "@/ui/avatar";
import { initialsOf } from "@/ui/avatar-spec";
import { Badge } from "@/ui/badge";
import {
  buttonSecondary,
  linkText,
  mono,
  panel,
  statTerm,
} from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";
import {
  formatCount,
  formatMoney,
  formatRatio,
  ratioWidth,
} from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { PressLink } from "@/ui/press-link";
import {
  CostFigure,
  Instant,
  NotRecordedValue,
  UnmeteredNote,
} from "./figures";
import { MonthTable, type MonthTableRow } from "./month-table";
import { SpendByDayChart } from "./spend-by-day-chart";
import { Empty, Panel } from "./tables";
import { SPEND_MONTH_BY, type SpendAt, type SpendMonthBy } from "./view";

type Row = SpendReport["rows"][number];

const chip = `${buttonSecondary} min-h-7 px-2.5 py-1 text-[12.5px] aria-pressed:border-rule aria-pressed:bg-hl aria-pressed:text-foreground`;

/** A UTC calendar day as a date, for the formatter. */
function dayDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** The workspace's monthly budget with a ceiling, the one the design meters. */
function monthlyBudget(budgets: SpendBudgets): SpendBudgets[number] | null {
  return (
    budgets.find(
      (budget) =>
        budget.scope === "workspace" &&
        budget.period === "monthly" &&
        budget.limit !== null,
    ) ?? null
  );
}

function BudgetMeter({
  budgets,
  at,
}: {
  budgets: Read<SpendBudgets>;
  at: SpendAt;
}) {
  const t = useTranslations("spend.month.budget");
  const locale = useLocale();
  // A budget read that did not answer says nothing here: the Budgets tab
  // carries its refusal, and "No budget set" would be a claim nobody read.
  if (!budgets.ok) return null;
  const budget = monthlyBudget(budgets.value);
  if (budget === null || budget.limit === null) {
    return (
      <SafeLink
        to={routes.spend(at.org, at.ws, { tab: "budgets" })}
        className={`${linkText} text-xs`}
      >
        {t("none")}
      </SafeLink>
    );
  }
  const reached = budget.ratio >= 1;
  const used = formatRatio(budget.ratio, locale);
  return (
    <div className="flex flex-col gap-1.5 pt-2" data-budget-state={budget.state}>
      <p className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{t("label")}</span>
        <span className="font-semibold">
          {t("used", {
            ratio: used,
            limit: formatMoney(budget.limit, { locale, precision: "cents" }),
          })}
        </span>
      </p>
      <span
        role="img"
        aria-label={t("position", { ratio: used })}
        className="block h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <span
          className={`block h-full ${reached ? "bg-destructive" : "bg-link"}`}
          style={{ width: ratioWidth(Math.min(1, budget.ratio)) }}
        />
      </span>
      {reached ? (
        <span>
          <Badge tone="denied">{t("reached")}</Badge>
        </span>
      ) : null}
    </div>
  );
}

function Total({
  report,
  budgets,
  at,
}: {
  report: SpendReport;
  budgets: Read<SpendBudgets>;
  at: SpendAt;
}) {
  const t = useTranslations("spend.month");
  const format = useFormatter();
  const days = report.days ?? [];
  const costs = days.flatMap((day) => (day.cost === null ? [] : [day.cost]));
  const peak = maxMoney(costs);
  const { from, to } = report.period;
  const monthDay = { month: "long", day: "numeric", timeZone: "UTC" } as const;
  return (
    <section
      aria-labelledby="spend-month-total"
      className={`${panel} grid gap-4 p-4 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id="spend-month-total" className={statTerm}>
          {format.dateTime(dayDate(from), {
            month: "long",
            year: "numeric",
            timeZone: "UTC",
          })}
        </h2>
        <p className="text-3xl font-semibold tracking-tight">
          <CostFigure cost={report.total.cost} />
        </p>
        <p className="text-xs text-muted-foreground">
          {t("span", {
            from: format.dateTime(dayDate(from), monthDay),
            to: format.dateTime(dayDate(to), monthDay),
            count: report.total.runs,
          })}
        </p>
        <UnmeteredNote
          unmetered={report.unmeteredRuns}
          className="text-xs text-muted-foreground"
          testId="spend-month-unmetered"
        />
        <BudgetMeter budgets={budgets} at={at} />
      </div>
      <div className="min-w-0">
        {peak === null ? (
          <Empty>{t("noPricedDay")}</Empty>
        ) : (
          <SpendByDayChart series={days} peak={peak} label={t("chart")} />
        )}
      </div>
    </section>
  );
}

function GroupLabel({ row, by }: { row: Row; by: SpendMonthBy }) {
  const t = useTranslations("spend.month");
  if (row.key === OTHER_SPEND_KEY) {
    return (
      <span className="flex min-w-0 flex-col">
        <span className="font-semibold">{t("other.label")}</span>
        <span className="text-xs text-muted-foreground">{t("other.note")}</span>
      </span>
    );
  }
  switch (by) {
    case "operator": {
      const name = row.operator?.name ?? t("unnamedOperator");
      return (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar
            value={row.operator?.avatarUrl ?? null}
            initials={initialsOf(name)}
            size={22}
          />
          <span className="truncate font-semibold">{name}</span>
        </span>
      );
    }
    case "model":
      return (
        <span className="flex min-w-0 flex-col">
          <span className={`${mono} truncate font-semibold`}>{row.key}</span>
          {row.provider === null ? null : (
            <span className="text-xs text-muted-foreground">
              {row.provider}
            </span>
          )}
        </span>
      );
    case "agent":
    case "mcp_server":
      return <span className={`${mono} truncate font-semibold`}>{row.key}</span>;
  }
}

function Share({
  row,
  total,
  largest,
}: {
  row: Row;
  total: MoneyValue | null;
  largest: MoneyValue | null;
}) {
  const locale = useLocale();
  const share =
    row.cost === null || total === null ? null : ratioOfMicros(row.cost, total);
  if (share === null) return <NotRecordedValue />;
  // The bar is the row against the largest group, as the design draws it; the
  // rest of the spend on the MCP server grouping draws none.
  const bar =
    row.key === OTHER_SPEND_KEY || row.cost === null || largest === null
      ? 0
      : (ratioOfMicros(row.cost, largest) ?? 0);
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="block h-1.5 w-24 overflow-hidden rounded-full bg-muted"
      >
        <span
          className="block h-full bg-link"
          style={{ width: ratioWidth(Math.min(1, bar)) }}
        />
      </span>
      <span className="font-mono text-xs text-muted-foreground tabular-nums">
        {formatRatio(share, locale)}
      </span>
    </span>
  );
}

function RunList({ row, at }: { row: Row; at: SpendAt }) {
  const t = useTranslations("spend.month");
  const runs = row.topRuns ?? [];
  const more = row.runs - runs.length;
  return (
    <ul className="flex flex-col">
      {runs.map((run: SpendTopRun) => (
        <li key={run.runId}>
          <SafeLink
            to={routes.run(at.org, at.ws, run.runId)}
            className="flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 hover:bg-hl"
          >
            <Avatar
              value={null}
              initials={initialsOf(run.agentKey ?? run.runId)}
              shape="agent"
              size={22}
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-foreground">
                {run.name ?? run.runId}
              </span>
              <span className="flex gap-2 text-xs text-muted-foreground">
                {run.agentKey === null ? null : (
                  <span className={mono}>{run.agentKey}</span>
                )}
                <Instant iso={run.startedAt} />
              </span>
            </span>
            <span className="ml-auto font-semibold">
              {run.cost === null ? (
                <NotRecordedValue />
              ) : (
                <Money value={run.cost} />
              )}
            </span>
          </SafeLink>
        </li>
      ))}
      {more > 0 ? (
        <li className="px-2 py-1.5 text-xs text-muted-foreground">
          {t("moreRuns", { count: more })}
        </li>
      ) : null}
    </ul>
  );
}

function GroupPicker({ by, at }: { by: SpendMonthBy; at: SpendAt }) {
  const t = useTranslations("spend.month.by");
  return (
    <div
      role="group"
      aria-label={t("label")}
      className="flex flex-wrap gap-1.5"
    >
      {SPEND_MONTH_BY.map((option) => (
        <PressLink
          key={option}
          to={routes.spend(at.org, at.ws, {
            tab: "month",
            by: option === "agent" ? undefined : option,
          })}
          pressed={option === by}
          data-by={option}
          className={chip}
        >
          {t(`options.${option}`)}
        </PressLink>
      ))}
    </div>
  );
}

export function MonthSection({
  report,
  budgets,
  by,
  at,
}: {
  /** The month to date, grouped by `by`. */
  report: SpendReport;
  budgets: Read<SpendBudgets>;
  by: SpendMonthBy;
  at: SpendAt;
}) {
  const t = useTranslations("spend.month");
  const locale = useLocale();
  const total = report.total.cost;
  const largest = maxMoney(
    report.rows.flatMap((row) =>
      row.key === OTHER_SPEND_KEY || row.cost === null ? [] : [row.cost],
    ),
  );
  const rows: MonthTableRow[] = report.rows.map((row) => ({
    key: row.key,
    label: <GroupLabel row={row} by={by} />,
    runs: row.key === OTHER_SPEND_KEY ? null : formatCount(row.runs, locale),
    share: <Share row={row} total={total} largest={largest} />,
    cost: <CostFigure cost={row.cost} />,
    runList:
      row.key === OTHER_SPEND_KEY || (row.topRuns ?? []).length === 0 ? null : (
        <RunList row={row} at={at} />
      ),
  }));
  const reported =
    report.reported === null ||
    report.reported === undefined ||
    report.reported.micros === "0"
      ? null
      : report.reported;
  return (
    <>
      <Total report={report} budgets={budgets} at={at} />
      <Panel
        id="spend-month-groups"
        title={t(`by.titles.${by}`)}
        action={<GroupPicker by={by} at={at} />}
        footer={
          reported === null
            ? undefined
            : t("reported", {
                amount: formatMoney(reported, { locale, precision: "cents" }),
              })
        }
      >
        {rows.length === 0 ? (
          <Empty>{t("empty")}</Empty>
        ) : (
          <MonthTable
            label={t(`by.titles.${by}`)}
            columns={[
              t(`by.options.${by}`),
              t("columns.runs"),
              t("columns.share"),
              t("columns.cost"),
            ]}
            rows={rows}
            totalLabel={t("columns.total")}
            total={<CostFigure cost={total} />}
          />
        )}
      </Panel>
    </>
  );
}
