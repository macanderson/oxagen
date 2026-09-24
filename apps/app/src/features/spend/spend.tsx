// The Spend page (#2962, #2963; spec `mockups/pages/spend.md`): what the
// tokens bought, with the basis on every number. The header with Export
// report and Set a budget, four summary tiles over every tab (hidden on a
// drill), the tabs with their live counts, and one tab's body or one key's
// drill. Every read is a noBillingGate kernel read through the spend port. The
// month's model rollup is the page's spine: when it does not answer, its state
// replaces the body; when it holds nothing, the empty state does. The other
// summary reads (findings, waste, budgets) leave their count off, and their
// tile not recorded, when they do not answer, and their own tab says why.
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
import { BudgetDialog } from "./budget-dialog";
import { CoachingSection } from "./coaching";
import { CostCenterTable } from "./cost-centers";
import { DrillSection } from "./drill";
import { ExportDialog } from "./export-dialog";
import { FindingEvidence, FindingsSection } from "./findings";
import { GatewayPolicySection } from "./gateway-policy";
import { PricingSection } from "./pricing";
import { SpendEmpty, SpendReadFailure, SpendSectionFailure } from "./states";
import { SummaryTiles } from "./summary";
import {
  AgentTable,
  BudgetsTable,
  ModelTable,
  OperatorTable,
  TaskTable,
  ToolSection,
} from "./tables";
import { SpendTabs } from "./tabs";
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
}: {
  ctx: WsCtx;
  at: SpendAt;
  month: string;
}) {
  const t = useTranslations();
  return (
    <PageHeader
      eyebrow={ctx.wsName}
      title={t("pages.spend")}
      description={t("spend.header.description")}
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
      view.drill === null
        ? { tab: view.tab }
        : { tab: view.tab, drill: view.drill },
    ),
    readAt: now.toISOString(),
  };
  const inTab = { ...failure, inline: true };
  const record = (
    // The record this page is actually showing: a drill's key or the finding
    // whose evidence is open.
    <PageRecord route="spend" id={view.finding ?? view.drill} />
  );
  const header = <Header ctx={ctx} at={at} month={period.from.slice(0, 7)} />;

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
    source.spend.byGroup(ctx, "model", period),
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
      <SummaryTiles month={month.value} waste={waste} />
      <SpendTabs
        at={at}
        current={view.tab}
        counts={{
          ...(findings.ok ? { findings: findings.value.counts.findings } : {}),
          ...(waste.ok ? { waste: waste.value.runsWithWaste } : {}),
          ...(budgets.ok ? { budgets: budgets.value.length } : {}),
        }}
      />
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
  view: SpendView;
  at: SpendAt;
  period: { from: string; to: string };
  month: SpendReport;
  findings: Read<SpendFindings>;
  waste: Awaited<ReturnType<DataSource["spend"]["waste"]>>;
  budgets: Awaited<ReturnType<DataSource["spend"]["budgets"]>>;
  failure: Omit<Parameters<typeof SpendReadFailure>[0], "read">;
}): Promise<ReactNode> {
  switch (view.tab) {
    case "findings": {
      if (!findings.ok)
        return <SpendReadFailure read={findings} {...failure} />;
      const [operators, evidence] = await Promise.all([
        source.spend.byGroup(ctx, "operator", period),
        view.finding === null
          ? Promise.resolve(null)
          : source.spend.findingEvidence(ctx, view.finding),
      ]);
      return (
        <FindingsSection
          findings={findings.value}
          operators={operators.ok ? operators.value.rows : []}
          at={at}
          evidence={
            evidence === null ? null : (
              <FindingEvidence evidence={evidence} at={at} />
            )
          }
        />
      );
    }
    case "tokens": {
      const agents = await source.spend.byGroup(ctx, "agent", period);
      return <TokensSection month={month} agents={agents} at={at} />;
    }
    case "coaching":
      return <CoachingSection />;
    case "operator":
    case "agent":
    case "tool":
    case "task": {
      const report = await source.spend.byGroup(ctx, view.tab, period);
      if (!report.ok) return <SpendReadFailure read={report} {...failure} />;
      const list = listed(findings);
      switch (view.tab) {
        case "operator":
          return (
            <OperatorTable report={report.value} findings={list} at={at} />
          );
        case "agent":
          return <AgentTable report={report.value} findings={list} at={at} />;
        case "tool":
          return <ToolSection report={report.value} findings={list} at={at} />;
        case "task":
          return <TaskTable report={report.value} />;
      }
      break;
    }
    case "model":
      return <ModelTable month={month} at={at} />;
    case "cost_center": {
      const report = await source.spend.byGroup(ctx, "cost_center", period);
      if (!report.ok) return <SpendReadFailure read={report} {...failure} />;
      return <CostCenterTable report={report.value} />;
    }
    case "waste":
      if (!waste.ok) return <SpendReadFailure read={waste} {...failure} />;
      return <WasteSection waste={waste.value} month={month} at={at} />;
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
