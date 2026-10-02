// The Spend page (#2962, #2963; spec `mockups/pages/spend.md`, the v3 Month
// tab in ADR-226): what the tokens bought, with the basis on every number. The
// header with Export report and Set a budget, four summary tiles over every tab
// but Month (hidden on a drill too), the tabs with their live counts, and one
// tab's body or one key's drill. Every read is a noBillingGate kernel read
// through the spend port. The month's rollup is the page's spine, grouped the
// way the Month tab asks and by model on every other tab: when it does not
// answer, its state replaces the body; when it holds nothing, the empty state
// does. The other summary reads (findings, waste, budgets) leave their count
// off, and their tile not recorded, when they do not answer, and their own tab
// says why.
import "server-only";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  SpendFinding,
  SpendFindings,
  SpendReport,
} from "@/data/contracts/spend";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import { PageRecord } from "@/features/shell";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { PageHeader } from "@/ui/page-header";
import { RouteTabPanel } from "@/ui/route-tabs";
import { BudgetDialog } from "./budget-dialog";
import { CostCenterTable } from "./cost-centers";
import { DrillSection } from "./drill";
import { ExportDialog } from "./export-dialog";
import { FindingEvidence, FindingsSection } from "./findings";
import { GatewayPolicySection } from "./gateway-policy";
import { MonthSection } from "./month";
import {
  canReadOperatorRanking,
  canSetOperatorPseudonyms,
  OperatorRankingSection,
} from "./operator-ranking";
import { PricingSection } from "./pricing";
import { SpendEmpty, SpendReadFailure, SpendSectionFailure } from "./states";
import { SummaryTiles } from "./summary";
import { BudgetsTable, TaskTable, ToolSection } from "./tables";
import { SPEND_PANEL, SpendTabs } from "./tabs";
import { TokensSection } from "./tokens";
import { monthToDate, type SpendAt, type SpendView } from "./view";
import { WasteSection } from "./waste";

type SpendProps = {
  ctx: WsCtx;
  source: DataSource;
  view: SpendView;
  /** Now, the instant the month to date is read up to; the clock when absent. */
  today?: Date;
};

function isEmpty(report: SpendReport): boolean {
  return report.total.runs === 0 && report.rows.length === 0;
}

function listed(read: Read<SpendFindings>): SpendFinding[] | null {
  return read.ok ? read.value.findings : null;
}

function Header({
  ctx,
  at,
  month,
  tab,
}: {
  ctx: WsCtx;
  at: SpendAt;
  month: string;
  tab: SpendView["tab"];
}) {
  const t = useTranslations();
  return (
    <PageHeader
      eyebrow={ctx.wsName}
      title={t("pages.spend")}
      description={
        tab === "month"
          ? t("spend.month.description")
          : t("spend.header.description")
      }
      actions={
        <>
          <ExportDialog at={at} month={month} />
          <BudgetDialog at={at} />
        </>
      }
    />
  );
}

export async function Spend({ ctx, source, view, today }: SpendProps) {
  const at: SpendAt = { org: ctx.orgSlug, ws: ctx.wsSlug };
  const now = today ?? requestInstant();
  const period = monthToDate(now);
  const failure = {
    ctx,
    retry: routes.spend(
      at.org,
      at.ws,
      view.drill !== null
        ? { tab: view.tab, drill: view.drill }
        : view.tab === "month" && view.by !== "agent"
          ? { tab: view.tab, by: view.by }
          : { tab: view.tab },
    ),
    readAt: now.toISOString(),
  };
  const inTab = { ...failure, inline: true };
  const record = (
    // The record this page is actually showing: a drill's key or the finding
    // whose evidence is open.
    <PageRecord route="spend" id={view.finding ?? view.drill} />
  );
  const header = (
    <Header
      ctx={ctx}
      at={at}
      month={period.from.slice(0, 7)}
      tab={view.tab}
    />
  );

  if (view.drill !== null) {
    const [drill, findings, names] = await Promise.all([
      source.spend.drill(ctx, view.tab, view.drill),
      source.spend.findings(ctx),
      view.tab === "operator"
        ? source.spend.byGroup(ctx, "operator", period)
        : Promise.resolve(null),
    ]);
    if (!drill.ok) return <SpendReadFailure read={drill} {...failure} />;
    const operator =
      names?.ok === true
        ? (names.value.rows.find((row) => row.key === view.drill)?.operator ??
          null)
        : null;
    return (
      <>
        {record}
        {header}
        <DrillSection
          drill={drill.value}
          findings={listed(findings)}
          operator={operator}
          at={at}
        />
      </>
    );
  }

  const [month, findings, waste, budgets] = await Promise.all([
    source.spend.byGroup(ctx, view.tab === "month" ? view.by : "model", period),
    source.spend.findings(ctx),
    source.spend.waste(ctx, period),
    source.spend.budgets(ctx),
  ]);
  if (!month.ok) return <SpendReadFailure read={month} {...failure} />;
  // Pricing is this build's own tab over the organization's price book, which
  // a workspace with nothing rolled up still needs in order to price its runs.
  if (view.tab !== "pricing" && isEmpty(month.value)) {
    return <SpendEmpty ctx={ctx} />;
  }
  return (
    <>
      {record}
      {header}
      {view.tab === "month" ? null : (
        <SummaryTiles month={month.value} waste={waste} />
      )}
      <SpendTabs
        at={at}
        current={view.tab}
        counts={{
          ...(findings.ok ? { findings: findings.value.counts.findings } : {}),
          ...(waste.ok ? { waste: waste.value.runsWithWaste } : {}),
          ...(budgets.ok ? { budgets: budgets.value.length } : {}),
        }}
      />
      <RouteTabPanel panel={SPEND_PANEL} className="flex flex-col gap-4">
        {
          await body({
            ctx,
            source,
            view,
            at,
            period,
            month: month.value,
            findings,
            waste,
            budgets,
            failure: inTab,
          })
        }
      </RouteTabPanel>
    </>
  );
}

async function body({
  ctx,
  source,
  view,
  at,
  period,
  month,
  findings,
  waste,
  budgets,
  failure,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** A tab's view: a drill renders before the body is asked for. */
  view: Extract<SpendView, { drill: null }>;
  at: SpendAt;
  period: { from: string; to: string };
  /** The month's rollup: by the Month tab's grouping there, by model elsewhere. */
  month: SpendReport;
  findings: Read<SpendFindings>;
  waste: Awaited<ReturnType<DataSource["spend"]["waste"]>>;
  budgets: Awaited<ReturnType<DataSource["spend"]["budgets"]>>;
  failure: Omit<Parameters<typeof SpendReadFailure>[0], "read">;
}): Promise<ReactNode> {
  switch (view.tab) {
    case "month":
      return (
        <MonthSection report={month} budgets={budgets} by={view.by} at={at} />
      );
    case "findings": {
      if (!findings.ok)
        return <SpendReadFailure read={findings} {...failure} />;
      // The hero leads with the month's unproductive spend, the total the
      // operator ranking's Total row prints. The ranking sits under the
      // findings it coaches from. It is asked only for a viewer who may read
      // it; anyone else sees who can (D15).
      const [operators, evidence, headline, ranking] = await Promise.all([
        source.spend.byGroup(ctx, "operator", period),
        view.finding === null
          ? Promise.resolve(null)
          : source.spend.findingEvidence(ctx, view.finding),
        source.spend.unproductive(ctx, period),
        canReadOperatorRanking(ctx)
          ? source.spend.operatorRanking(ctx, period)
          : Promise.resolve(null),
      ]);
      return (
        <>
          <FindingsSection
            headline={headline}
            findings={findings.value}
            operators={operators.ok ? operators.value.rows : []}
            at={at}
            evidence={
              evidence === null ? null : (
                <FindingEvidence evidence={evidence} at={at} />
              )
            }
          />
          <OperatorRankingSection
            ranking={ranking}
            at={at}
            canSetPseudonyms={canSetOperatorPseudonyms(ctx)}
          />
        </>
      );
    }
    case "tokens": {
      const agents = await source.spend.byGroup(ctx, "agent", period);
      return <TokensSection month={month} agents={agents} at={at} />;
    }
    case "tool":
    case "task": {
      const report = await source.spend.byGroup(ctx, view.tab, period);
      if (!report.ok) return <SpendReadFailure read={report} {...failure} />;
      return view.tab === "tool" ? (
        <ToolSection
          report={report.value}
          findings={listed(findings)}
          at={at}
        />
      ) : (
        <TaskTable report={report.value} />
      );
    }
    case "cost_center": {
      const report = await source.spend.byGroup(ctx, "cost_center", period);
      if (!report.ok) return <SpendReadFailure read={report} {...failure} />;
      return <CostCenterTable report={report.value} />;
    }
    case "waste":
      if (!waste.ok) return <SpendReadFailure read={waste} {...failure} />;
      return (
        <WasteSection
          waste={waste.value}
          findings={listed(findings)}
          month={month}
          at={at}
        />
      );
    case "budgets": {
      if (!budgets.ok) return <SpendReadFailure read={budgets} {...failure} />;
      const gateway = await source.spend.gatewayPolicy(ctx);
      return (
        <>
          <BudgetsTable budgets={budgets.value} at={at} />
          {/* The gateway policy renders its own refusal rather than blanking
              the tab: the spend ceilings above are a separate question and a
              person is still owed them when this read is down. */}
          {gateway.ok ? (
            <GatewayPolicySection
              at={at}
              policy={gateway.value}
              canEdit={ctx.wsRole === "owner" || ctx.wsRole === "admin"}
            />
          ) : (
            <SpendSectionFailure read={gateway} />
          )}
        </>
      );
    }
    // The book and the models it cannot price are two independent questions,
    // and a person whose price book answers is still owed it when the unpriced
    // read is down (and the other way round). Each half renders its own
    // refusal rather than one of them blanking the tab.
    case "pricing": {
      const [book, unpriced] = await Promise.all([
        source.spend.priceBook(ctx),
        source.spend.unpricedModels(ctx),
      ]);
      return <PricingSection book={book} unpriced={unpriced} at={at} />;
    }
  }
}

/**
 * The instant this request reads the month to date. Outside the component so
 * the purity rule, which is syntactic, does not read an async server
 * component's once-per-request clock as a render-time impurity (as
 * `features/agents` and `features/mandate` do).
 */
function requestInstant(): Date {
  return new Date();
}
