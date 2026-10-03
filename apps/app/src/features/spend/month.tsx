// The Month tab (#2962; v3 mockup `spdMonth`, ADR-226): what every run cost
// this month, from its own model requests. The total with the workspace's
// monthly budget beside it, the spend by day, and one table grouped by agent,
// operator, model, or MCP server, each row opening to its costliest runs. One
// get_spend read at the chosen grouping carries all of it. The design's Budget
// column is not drawn: a budget holds for the organization or the workspace,
// never one agent or one operator (#3864). Grouped by agent, a second read
// (get_spend_per_merged_pr, F26) adds each agent's spend per merged PR beside
// its cost, and the agent's open row lists the runs behind that figure.
import { useLocale, useTranslations } from "next-intl";
import {
  type Cost,
  differenceOfMicros,
  maxMoney,
  type Money as MoneyValue,
  ratioOfMicros,
  sumMoney,
} from "@/data/contracts/money";
import {
  type AgentPerMergedPr,
  ASSISTANT_SPEND_KEY,
  OTHER_SPEND_KEY,
  type SpendBudgets,
  type SpendPerMergedPr,
  type SpendReport,
  type SpendTopRun,
} from "@/data/contracts/spend";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { AgentAvatar } from "@/ui/agent-avatar";
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
import { ModelLabel } from "@/ui/provider-mark";
import { type AgentHarnesses, AgentMark, harnessIn } from "./agent-mark";
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

const chip = `${buttonSecondary} min-h-7 px-2.5 py-1 text-sm aria-pressed:border-rule aria-pressed:bg-hl aria-pressed:text-foreground`;

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
        className={`${linkText} text-sm`}
      >
        {t("none")}
      </SafeLink>
    );
  }
  const reached = budget.ratio >= 1;
  // A budget that is not enforced stops no run, so reaching it is a fact to
  // note and not an alarm.
  const alarm = reached && budget.enabled;
  const used = formatRatio(budget.ratio, locale);
  return (
    <div className="flex flex-col gap-1.5 pt-2" data-budget-state={budget.state}>
      <p className="flex items-baseline justify-between gap-3 text-sm">
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
          className={`block h-full ${alarm ? "bg-destructive" : "bg-link"}`}
          style={{ width: ratioWidth(Math.min(1, budget.ratio)) }}
        />
      </span>
      {reached || !budget.enabled ? (
        <span className="flex flex-wrap gap-1.5">
          {reached ? (
            <Badge tone={alarm ? "denied" : "quiet"}>{t("reached")}</Badge>
          ) : null}
          {budget.enabled ? null : (
            <Badge tone="quiet">{t("notEnforced")}</Badge>
          )}
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
  const tSummary = useTranslations("spend.summary");
  const format = useFormatter();
  // Open runs whose running cost is in the total (#3980); final once they seal.
  const estimatedRuns = report.estimatedRuns ?? 0;
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
        <p className="text-sm text-muted-foreground">
          {t("span", {
            from: format.dateTime(dayDate(from), monthDay),
            to: format.dateTime(dayDate(to), monthDay),
            count: report.total.runs,
          })}
        </p>
        {report.total.cost === null || estimatedRuns === 0 ? null : (
          <p
            className="text-sm text-muted-foreground"
            data-testid="spend-month-estimate"
          >
            {tSummary("estimated", { count: estimatedRuns })}
          </p>
        )}
        <UnmeteredNote
          unmetered={report.unmeteredRuns}
          className="text-sm text-muted-foreground"
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

/**
 * The row key of the spend the agent, operator, and model groupings leave out:
 * runs that recorded no agent, operator, or model, and runs the daily rollup
 * has not counted yet. No group key starts with a tilde.
 */
const UNGROUPED_KEY = "~ungrouped";

/**
 * What the total holds beyond the priced groups, or null when the groups
 * account for all of it.
 */
function ungroupedCost(report: SpendReport): Cost | null {
  const total = report.total.cost;
  if (total === null) return null;
  const priced = report.rows.flatMap((row) =>
    row.cost === null ? [] : [row.cost],
  );
  // Groups in more than one currency have no sum to set against the total.
  const grouped =
    priced.length === 0
      ? { micros: "0", currency: total.currency }
      : sumMoney(priced);
  if (grouped === null) return null;
  const rest = differenceOfMicros(total, grouped);
  if (rest === null || rest.sign <= 0) return null;
  return { ...rest.gap, basis: total.basis };
}

function UngroupedLabel({
  by,
}: {
  by: Exclude<SpendMonthBy, "mcp_server">;
}) {
  const t = useTranslations("spend.month.ungrouped");
  return (
    <span className="flex min-w-0 flex-col">
      <span className="font-semibold">{t("label")}</span>
      <span className="text-sm text-muted-foreground">{t(`note.${by}`)}</span>
    </span>
  );
}

/**
 * A group's name, linked to its drill. Only an agent and an operator have a
 * drill: `get_spend_drill` has no model or MCP server kind. An agent's name
 * carries its avatar with the harness it registered (#4871).
 */
function GroupLabel({
  row,
  by,
  at,
  harnesses,
}: {
  row: Row;
  by: SpendMonthBy;
  at: SpendAt;
  harnesses: AgentHarnesses;
}) {
  const t = useTranslations("spend.month");
  if (row.key === OTHER_SPEND_KEY) {
    return (
      <span className="flex min-w-0 flex-col">
        <span className="font-semibold">{t("other.label")}</span>
        <span className="text-sm text-muted-foreground">{t("other.note")}</span>
      </span>
    );
  }
  // The in-app assistant's spend: Oxagen runs it and the workspace does not
  // monitor it, so its row links to no drill and lists no runs (ADR-235).
  if (row.key === ASSISTANT_SPEND_KEY) {
    return (
      <span className="flex min-w-0 flex-col">
        <span className="font-semibold">{t("assistant.label")}</span>
        <span className="text-sm text-muted-foreground">
          {t("assistant.note")}
        </span>
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
          <SafeLink
            to={routes.spend(at.org, at.ws, { tab: "operator", drill: row.key })}
            className={`${linkText} truncate font-semibold`}
          >
            {name}
          </SafeLink>
        </span>
      );
    }
    case "model":
      return (
        <span className="flex min-w-0 flex-col">
          <ModelLabel
            model={row.key}
            provider={row.provider}
            className="font-semibold"
          />
          {row.provider === null ? null : (
            <span className="text-sm text-muted-foreground">
              {row.provider}
            </span>
          )}
        </span>
      );
    case "agent":
      return (
        <span className="flex min-w-0 items-center gap-2">
          <AgentMark
            agentKey={row.key}
            harness={harnessIn(harnesses, row.key)}
          />
          <SafeLink
            to={routes.spend(at.org, at.ws, { tab: "agent", drill: row.key })}
            className={`${linkText} ${mono} min-w-0 truncate font-semibold`}
          >
            {row.key}
          </SafeLink>
        </span>
      );
    case "mcp_server":
      return <span className={`${mono} truncate font-semibold`}>{row.key}</span>;
  }
}

function Share({
  cost,
  total,
  largest,
}: {
  cost: MoneyValue | null;
  total: MoneyValue | null;
  /** The largest group's cost, or null for a row that draws no bar. */
  largest: MoneyValue | null;
}) {
  const locale = useLocale();
  const share =
    cost === null || total === null ? null : ratioOfMicros(cost, total);
  if (share === null) return <NotRecordedValue />;
  // The bar is the row against the largest group, as the design draws it.
  const bar =
    cost === null || largest === null ? 0 : (ratioOfMicros(cost, largest) ?? 0);
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
      <span className="font-mono text-sm text-muted-foreground tabular-nums">
        {formatRatio(share, locale)}
      </span>
    </span>
  );
}

function RunList({
  row,
  at,
  harnesses,
}: {
  row: Row;
  at: SpendAt;
  harnesses: AgentHarnesses;
}) {
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
            <AgentAvatar
              value={null}
              initials={initialsOf(run.agentKey ?? run.runId)}
              // A ledger run records no harness; its agent's registered one
              // stands in.
              harness={run.harness ?? harnessIn(harnesses, run.agentKey)}
              size={22}
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-foreground">
                {run.name ?? run.runId}
              </span>
              <span className="flex gap-2 text-sm text-muted-foreground">
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
        <li className="px-2 py-1.5 text-sm text-muted-foreground">
          {t("moreRuns", { count: more })}
        </li>
      ) : null}
    </ul>
  );
}

/** `github:owner/repo#N` as `owner/repo#N`. */
function prName(prKey: string): string {
  const colon = prKey.indexOf(":");
  return colon === -1 ? prKey : prKey.slice(colon + 1);
}

const PR_TONE = {
  merged: "allowed",
  reverted: "failed",
  closed: "denied",
  open: "quiet",
  unread: "quiet",
} as const satisfies Record<
  AgentPerMergedPr["runs"][number]["pullRequests"][number]["state"],
  "allowed" | "failed" | "denied" | "quiet"
>;

/**
 * An agent's spend per merged PR, or absent with the reason. An agent with
 * no entry opened no PR in the period, so it has no figure either.
 */
function PerMergedPrFigure({ agent }: { agent: AgentPerMergedPr | null }) {
  const t = useTranslations("spend.month.perMergedPr");
  if (agent === null) {
    return (
      <span className="flex flex-col items-end" data-per-merged-pr="absent">
        <span className="text-muted-foreground">{t("absent")}</span>
        <span className="text-sm text-muted-foreground">
          {t("absence.no_bounded_run")}
        </span>
      </span>
    );
  }
  const unpriced =
    agent.unpricedRuns === 0 ? null : (
      <span className="text-sm text-muted-foreground">
        {t("unpriced", { count: agent.unpricedRuns })}
      </span>
    );
  if (agent.perMergedPr === null) {
    const reason =
      agent.absence === "no_merged_pr" || agent.absence === null
        ? t("absence.no_merged_pr", { runs: agent.boundedRuns })
        : t(`absence.${agent.absence}`);
    return (
      <span className="flex flex-col items-end" data-per-merged-pr="absent">
        <span className="text-muted-foreground">{t("absent")}</span>
        <span className="text-sm text-muted-foreground">{reason}</span>
        {unpriced}
      </span>
    );
  }
  return (
    <span className="flex flex-col items-end" data-per-merged-pr="figure">
      <span className="font-semibold">
        <Money value={agent.perMergedPr} />
      </span>
      <span className="text-sm text-muted-foreground">
        {t("figure", { merged: agent.mergedPrs, runs: agent.boundedRuns })}
      </span>
      {unpriced}
    </span>
  );
}

/** The bounded runs behind an agent's figure, each linked to its run page. */
function PerMergedPrRuns({
  agent,
  at,
}: {
  agent: AgentPerMergedPr;
  at: SpendAt;
}) {
  const t = useTranslations("spend.month.perMergedPr");
  const more = agent.boundedRuns - agent.runs.length;
  return (
    <section
      aria-label={t("runsTitle")}
      className="flex flex-col gap-1 border-t border-border pt-2"
      data-testid="spend-month-per-merged-pr-runs"
    >
      <h3 className="px-2 text-sm font-semibold">{t("runsTitle")}</h3>
      <p className="px-2 text-sm text-muted-foreground">{t("runsNote")}</p>
      <ul className="flex flex-col">
        {agent.runs.map((run) => (
          <li
            key={run.runId}
            className="flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 hover:bg-hl"
          >
            <span className="flex min-w-0 flex-col">
              <SafeLink
                to={routes.run(at.org, at.ws, run.runId)}
                className={`${linkText} ${mono} truncate`}
              >
                {run.runId}
              </SafeLink>
              <span className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                <Instant iso={run.startedAt} />
                {run.pullRequests.map((pr) => (
                  <span
                    key={pr.prKey}
                    className="inline-flex items-center gap-1"
                    data-pr-state={pr.state}
                  >
                    <span className={mono}>{prName(pr.prKey)}</span>
                    <Badge tone={PR_TONE[pr.state]}>{t(`state.${pr.state}`)}</Badge>
                  </span>
                ))}
              </span>
            </span>
            <span className="ml-auto font-semibold">
              {run.cost === null ? <NotRecordedValue /> : <Money value={run.cost} />}
            </span>
          </li>
        ))}
        {more > 0 ? (
          <li className="px-2 py-1.5 text-sm text-muted-foreground">
            {t("moreRuns", { count: more })}
          </li>
        ) : null}
      </ul>
    </section>
  );
}

/** Each agent's figure by key, or null when the read did not answer. */
function perMergedPrByAgent(
  read: Read<SpendPerMergedPr> | null,
): Map<string, AgentPerMergedPr> | null {
  if (read === null || !read.ok) return null;
  return new Map(read.value.agents.map((agent) => [agent.agentKey, agent]));
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
  perMergedPr = null,
  harnesses = {},
}: {
  /** The month to date, grouped by `by`. */
  report: SpendReport;
  budgets: Read<SpendBudgets>;
  by: SpendMonthBy;
  at: SpendAt;
  /** Each agent's spend per merged PR over the same month; read only by agent. */
  perMergedPr?: Read<SpendPerMergedPr> | null;
  /** Each agent's registered harness, by key, for the avatars' badges. */
  harnesses?: AgentHarnesses;
}) {
  const t = useTranslations("spend.month");
  const locale = useLocale();
  const total = report.total.cost;
  // The caret's label names the group: an operator by name, any other by key.
  const nameOf = (row: Row) =>
    row.key === ASSISTANT_SPEND_KEY
      ? t("assistant.label")
      : by === "operator" && row.key !== OTHER_SPEND_KEY
        ? (row.operator?.name ?? t("unnamedOperator"))
        : row.key;
  const largest = maxMoney(
    report.rows.flatMap((row) =>
      row.key === OTHER_SPEND_KEY || row.cost === null ? [] : [row.cost],
    ),
  );
  // A per-merged-PR read that did not answer adds no column, as a budget read
  // that did not answer adds no meter: an absent figure would be a claim
  // nobody read.
  const merged = by === "agent" ? perMergedPrByAgent(perMergedPr) : null;
  // The rest of the spend on the MCP server grouping, and the ungrouped
  // remainder, draw no bar and count no runs: neither is one group.
  const rows: MonthTableRow[] = report.rows.map((row) => {
    // The in-app assistant's row, like Other spend, is no group the
    // workspace manages: it opens no runs and no per-PR figure (ADR-235).
    const ownGroup =
      row.key !== OTHER_SPEND_KEY && row.key !== ASSISTANT_SPEND_KEY;
    const agent =
      merged === null || !ownGroup ? null : (merged.get(row.key) ?? null);
    const costliest =
      !ownGroup || (row.topRuns ?? []).length === 0 ? null : (
        <RunList row={row} at={at} harnesses={harnesses} />
      );
    const behind =
      agent === null || agent.runs.length === 0 ? null : (
        <PerMergedPrRuns agent={agent} at={at} />
      );
    return {
      key: row.key,
      label: <GroupLabel row={row} by={by} at={at} harnesses={harnesses} />,
      toggleLabel: t("showRuns", { name: nameOf(row) }),
      runs: row.key === OTHER_SPEND_KEY ? null : formatCount(row.runs, locale),
      share: (
        <Share
          cost={row.cost}
          total={total}
          largest={row.key === OTHER_SPEND_KEY ? null : largest}
        />
      ),
      cost: <CostFigure cost={row.cost} />,
      runList:
        costliest === null && behind === null ? null : (
          <div className="flex flex-col gap-2">
            {costliest}
            {behind}
          </div>
        ),
      ...(merged === null || !ownGroup
        ? {}
        : {
            extra: {
              content: <PerMergedPrFigure agent={agent} />,
              toggleLabel:
                behind === null
                  ? null
                  : t("perMergedPr.show", { name: nameOf(row) }),
            },
          }),
    };
  });
  // The priced rows then sum to the Total row beneath them. The MCP server
  // grouping needs no such row: Other spend holds the rest of each run.
  const ungrouped = by === "mcp_server" ? null : ungroupedCost(report);
  if (ungrouped !== null && by !== "mcp_server") {
    rows.push({
      key: UNGROUPED_KEY,
      label: <UngroupedLabel by={by} />,
      toggleLabel: t("ungrouped.label"),
      runs: null,
      share: <Share cost={ungrouped} total={total} largest={null} />,
      cost: <CostFigure cost={ungrouped} />,
      runList: null,
    });
  }
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
        {report.rows.length === 0 ? (
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
            {...(merged === null
              ? {}
              : { extraColumn: t("perMergedPr.column") })}
          />
        )}
      </Panel>
    </>
  );
}
